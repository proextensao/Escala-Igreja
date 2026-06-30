const express = require("express");
const cors = require("cors");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
app.use(cors({
  origin: "*", 
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "api-key"]
}));
app.use(express.json());

// ── Firebase Admin ──
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = getFirestore();

// ── Brevo ──
const BREVO_KEY = process.env.BREVO_API_KEY;
const SENDER_EMAIL = process.env.SENDER_EMAIL || "escala@nacaosanta.com.br";
const SENDER_NAME = process.env.SENDER_NAME || "Escala Nação Santa";

async function enviarEmail(para, nomePara, assunto, htmlContent) {
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": BREVO_KEY,
    },
    body: JSON.stringify({
      sender: { name: SENDER_NAME, email: SENDER_EMAIL },
      to: [{ email: para, name: nomePara }],
      subject: assunto,
      htmlContent,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo error: ${err}`);
  }
  return res.json();
}

// ============================================================================
// OBJETIVOS 1 E 2: ROTA PARA O CADASTRO E PARA O BOTÃO DO PAINEL
// ============================================================================
app.post("/enviar-email", async (req, res) => {
  const apiKey = req.headers["api-key"];
  if (apiKey !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ erro: "Não autorizado" });
  }

  const { para, nomePara, assunto, html } = req.body;
  try {
    await enviarEmail(para, nomePara, assunto, html);
    res.json({ sucesso: true });
  } catch (err) {
    console.error("Erro ao enviar email:", err.message);
    res.status(500).json({ erro: err.message });
  }
});


// ============================================================================
// OBJETIVO 3: LÓGICA DO LEMBRETE AUTOMÁTICO (1 DIA ANTES)
// ============================================================================
async function dispararLembretesDeAmanha() {
  try {
    console.log("Iniciando verificação de lembretes automáticos...");

    // Calcula "amanhã" adicionando 24 horas em milissegundos
    const agora = new Date();
    const amanhaMs = agora.getTime() + (24 * 60 * 60 * 1000);
    const amanha = new Date(amanhaMs);

    // Extrai com segurança os componentes no fuso horário de Brasília
    const formatter = new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      year: "numeric", month: "2-digit", day: "2-digit"
    });

    const partes = formatter.formatToParts(amanha);
    const dd = partes.find(p => p.type === 'day').value;
    const mm = partes.find(p => p.type === 'month').value;
    const aaaa = partes.find(p => p.type === 'year').value;

    const dataAlvo = `${dd}/${mm}/${aaaa}`; // Formato exato da tabela: 13/06/2026
    const mesRef = `${aaaa}-${mm}`;

    console.log(`Buscando escalas para a data: ${dataAlvo} (mesRef: ${mesRef})`);

    // Busca as escalas salvas do mês atual
    const escalasSnap = await db.collection("historico_escalas").where("mesReferencia", "==", mesRef).get();

    if (escalasSnap.empty) {
      console.log("Nenhuma escala encontrada para o mês:", mesRef);
      return;
    }

    // Busca os e-mails dos voluntários
    const volSnap = await db.collection("voluntarios").get();
    const emailMap = {};
    volSnap.forEach(d => {
      const v = d.data();
      // O .trim() garante que "José " seja tratado como "José"
      if (v.nome && v.email) emailMap[v.nome.trim()] = v.email.trim();
    });

    for (const docEscala of escalasSnap.docs) {
      const escala = docEscala.data();

      for (const linha of escala.linhas) {
        // Normaliza a data vinda do banco (Garante DD/MM/AAAA mesmo se vier D/M/AAAA)
        let dataLinhaNorm = linha.data ? String(linha.data).trim() : "";
        const partesData = dataLinhaNorm.split('/');
        if (partesData.length === 3) {
          dataLinhaNorm = `${partesData[0].padStart(2, '0')}/${partesData[1].padStart(2, '0')}/${partesData[2]}`;
        }

        const nomeVoluntario = linha.voluntario ? String(linha.voluntario).trim() : "";

        // Se a data do evento for amanhã...
        if (dataLinhaNorm === dataAlvo && nomeVoluntario && nomeVoluntario !== "A definir") {
          const email = emailMap[nomeVoluntario];
          
          if (email) {
            const primeiroNome = nomeVoluntario.split(" ")[0];
            const assunto = `⏰ Lembrete: Escala Amanhã (${linha.evento})`;
            const html = `
              <div style="font-family:sans-serif; max-width:500px; margin:0 auto; background:#f8fafc; padding:20px; border-radius:10px;">
                <h2 style="color:#1e293b;">Olá, ${primeiroNome}! 👋</h2>
                <p style="color:#475569; font-size:15px;">Este é um lembrete automático de que você está escalado(a) para servir <b>amanhã</b>.</p>
                <div style="background:white; padding:15px; border-radius:8px; border-left:4px solid #2563eb; margin:20px 0;">
                  <p style="margin:5px 0;"><b>Ministério:</b> ${escala.ministerio}</p>
                  <p style="margin:5px 0;"><b>Evento:</b> ${linha.evento}</p>
                  <p style="margin:5px 0;"><b>Data:</b> ${linha.data} (${linha.dia})</p>
                  <p style="margin:5px 0;"><b>Hora:</b> ${linha.hora}</p>
                </div>
                <p style="color:#64748b; font-size:12px; text-align:center;">Nação Santa — Gerenciador de Escala</p>
              </div>
            `;
            try {
              await enviarEmail(email, nomeVoluntario, assunto, html);
              console.log(`✅ Lembrete enviado para ${nomeVoluntario} (${email})`);
            } catch (errEmail) {
              console.error(`❌ Falha ao enviar lembrete para ${nomeVoluntario}:`, errEmail.message);
            }
          } else {
            console.log(`⚠️ Voluntário escalado amanhã mas sem e-mail: ${nomeVoluntario}`);
          }
        }
      }
    }

    console.log("Verificação de lembretes concluída.");
  } catch (error) {
    console.error("Erro no lembrete automático:", error);
  }
}

// ✅ CORREÇÃO #1: res.end() antes de executar a função, evita "output too large"
app.get("/disparar-lembretes-diarios", (req, res) => {
  res.sendStatus(200);
  dispararLembretesDeAmanha();
});


// ── Health check / Keep-Alive ──
app.get("/", (req, res) => res.sendStatus(200));
app.get("/ping", (req, res) => res.sendStatus(200));

// ============================================================================
// OBJETIVO 4: MENSAGEM SEMANAL AUTOMÁTICA (TODA SEGUNDA DE MANHÃ)
// ============================================================================

// Banco de mensagens positivas / versículos (rotação automática por semana)
const MENSAGENS_SEMANAIS = [
  {
    versiculo: "Tudo posso naquele que me fortalece.",
    referencia: "Filipenses 4:13",
    reflexao: "Nesta semana, lembre-se: suas forças têm uma fonte maior. Caminhe com confiança!"
  },
  {
    versiculo: "O Senhor é o meu pastor; de nada terei falta.",
    referencia: "Salmos 23:1",
    reflexao: "Comece a semana descansando na certeza de que Deus cuida de cada detalhe da sua vida."
  },
  {
    versiculo: "Não temas, porque eu sou contigo; não te assombres, porque eu sou o teu Deus.",
    referencia: "Isaías 41:10",
    reflexao: "Se o medo tentar te paralisar essa semana, lembre-se: você não está sozinho(a)."
  },
  {
    versiculo: "Entrega o teu caminho ao Senhor, confia nele, e ele tudo fará.",
    referencia: "Salmos 37:5",
    reflexao: "Que essa semana seja marcada por confiança e entrega. Deus está no controle!"
  },
  {
    versiculo: "Alegrai-vos sempre no Senhor; outra vez digo, alegrai-vos.",
    referencia: "Filipenses 4:4",
    reflexao: "A alegria do Senhor é a nossa força. Comece essa semana com um coração agradecido!"
  },
  {
    versiculo: "Tudo o que fizerem, façam de todo o coração, como para o Senhor.",
    referencia: "Colossenses 3:23",
    reflexao: "Seu serviço faz diferença! Que cada tarefa dessa semana seja feita com excelência e amor."
  },
  {
    versiculo: "Os que esperam no Senhor renovarão as forças; subirão com asas como águias.",
    referencia: "Isaías 40:31",
    reflexao: "Renove suas energias essa semana. Há novas forças disponíveis para você!"
  },
  {
    versiculo: "Sede fortes e corajosos... o Senhor, vosso Deus, é contigo por onde quer que andares.",
    referencia: "Josué 1:9",
    reflexao: "Coragem para os desafios dessa semana! Deus caminha ao seu lado."
  }
];

// ✅ CORREÇÃO #2: Usa fuso horário de Brasília para calcular a semana corretamente
function obterMensagemDaSemana() {
  const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const inicioAno = new Date(agora.getFullYear(), 0, 1);
  const diasPassados = Math.floor((agora - inicioAno) / 86400000);
  const numeroSemana = Math.floor(diasPassados / 7);
  const indice = numeroSemana % MENSAGENS_SEMANAIS.length;
  return MENSAGENS_SEMANAIS[indice];
}

// Mensagem fixa de início de semana — {NOME} é substituído pelo primeiro nome do voluntário
const MENSAGEM_FIXA_TEMPLATE = `Bom dia!! {NOME}
Desejamos a você uma semana abençoada e queremos lembrar a você do quanto é precioso(a) para nós e para o Reino. Sei que a rotina é corrida, mas nunca se esqueça que o que nos une é um propósito maior de amor e serviço.
Que, nesta semana, o Senhor renove suas forças e coloque paz em cada detalhe. Vamos cuidar uns dos outros, caminhar juntos e confiar que Ele está no controle de cada passo nosso.`;

function montarHtmlMensagemSemanal(nomeVoluntario, mensagemBiblica) {
  const primeiroNome = (nomeVoluntario || "").split(" ")[0];

  const nomesMeses = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];

  // ✅ CORREÇÃO #3: Usa fuso horário de Brasília para exibir mês/ano correto no e-mail
  const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
  const mesAtual = nomesMeses[agora.getMonth()];
  const anoAtual = agora.getFullYear();

  const mensagemPersonalizada = MENSAGEM_FIXA_TEMPLATE
    .replace("{NOME}", primeiroNome)
    .split("\n")
    .map(linha => `<p style="color:#475569; font-size:14px; line-height:1.6; margin:0 0 12px 0;">${linha}</p>`)
    .join("");

  return `
    <div style="font-family:'Segoe UI',sans-serif; max-width:520px; margin:0 auto; background:#f8fafc; padding:24px; border-radius:12px;">
      <div style="background:#1e293b; padding:24px; border-radius:8px; text-align:center; margin-bottom:24px;">
        <h1 style="margin:0 0 12px 0; font-size:28px;"><b style="color:white;">Nação</b><span style="color:#94a3b8;">Santa</span></h1>
        <h2 style="color:white; margin:0; font-size:20px;">🌅 Início de Semana</h2>
        <p style="color:#94a3b8; margin:6px 0 0 0; font-size:14px;">${mesAtual} ${anoAtual} — Nação Santa</p>
      </div>

      ${mensagemPersonalizada}

      <div style="background:white; padding:18px; border-radius:8px; border-left:4px solid #2563eb; margin:20px 0; box-shadow:0 2px 8px rgba(0,0,0,0.06);">
        <p style="margin:0 0 8px 0; color:#1e293b; font-size:15px; font-style:italic;">"${mensagemBiblica.versiculo}"</p>
        <p style="margin:0 0 12px 0; color:#2563eb; font-size:13px; font-weight:bold;">${mensagemBiblica.referencia}</p>
        <p style="margin:0; color:#475569; font-size:13px; line-height:1.6;">${mensagemBiblica.reflexao}</p>
      </div>

      <p style="color:#64748b; font-size:12px; text-align:center; margin-top:20px;">
        Que Deus abençoe sua semana! 🙏<br>
        <span style="color:#94a3b8;">Enviado automaticamente pelo sistema — Nação Santa</span>
      </p>
    </div>`;
}

async function dispararMensagemSemanal() {
  try {
    console.log("Iniciando envio da mensagem semanal...");

    const mensagemBiblica = obterMensagemDaSemana();

    const volSnap = await db.collection("voluntarios").get();

    let enviados = 0, falhas = 0;

    for (const docVol of volSnap.docs) {
      const v = docVol.data();
      if (!v.email || !v.nome) continue;

      const html = montarHtmlMensagemSemanal(v.nome.trim(), mensagemBiblica);
      const assunto = "🌅 Bom dia! Mensagem de início de semana — Nação Santa";

      try {
        await enviarEmail(v.email.trim(), v.nome.trim(), assunto, html);
        enviados++;
        console.log(`✅ Mensagem semanal enviada para ${v.nome} (${v.email})`);
      } catch (errEmail) {
        falhas++;
        console.error(`❌ Falha ao enviar para ${v.nome}:`, errEmail.message);
      }
    }

    console.log(`Mensagem semanal concluída. Enviados: ${enviados} | Falhas: ${falhas}`);
  } catch (error) {
    console.error("Erro na mensagem semanal:", error);
  }
}

// ✅ CORREÇÃO #4: res.end() antes de executar a função, evita "output too large"
app.get("/disparar-mensagem-semanal", (req, res) => {
  res.sendStatus(200);
  dispararMensagemSemanal();
});



// ============================================================================
// OBJETIVO 5: LEMBRETE AUTOMÁTICO DE DISPONIBILIDADE (ÚLTIMO DIA DO MÊS)
// ============================================================================

async function dispararLembreteDisponibilidade() {
  try {
    console.log("Iniciando verificação de lembrete de disponibilidade...");

    const agora = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));

    // Verifica se hoje é o último dia do mês
    const ultimoDiaMes = new Date(agora.getFullYear(), agora.getMonth() + 1, 0).getDate();
    if (agora.getDate() !== ultimoDiaMes) {
      console.log(`Hoje é dia ${agora.getDate()}, último dia é ${ultimoDiaMes}. Nada a enviar.`);
      return;
    }

    // Calcula o mês seguinte (referência que os voluntários devem preencher)
    const mesSeguinte = new Date(agora.getFullYear(), agora.getMonth() + 1, 1);
    const anoRef = mesSeguinte.getFullYear();
    const mesRef = String(mesSeguinte.getMonth() + 1).padStart(2, "0");
    const mesReferencia = `${anoRef}-${mesRef}`;

    const nomesMeses = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho",
                        "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
    const nomeMesSeguinte = nomesMeses[mesSeguinte.getMonth()];

    console.log(`Último dia do mês! Verificando quem não preencheu disponibilidade para: ${mesReferencia}`);

    const volSnap = await db.collection("voluntarios").get();

    let enviados = 0, falhas = 0, semEmail = 0;

    for (const docVol of volSnap.docs) {
      const v = docVol.data();
      if (!v.nome) continue;

      if (!v.email) {
        semEmail++;
        console.log(`⚠️ Sem e-mail: ${v.nome}`);
        continue;
      }

      // Já preencheu o mês seguinte — pula
      if (v.mesReferencia === mesReferencia || (v.disponibilidades && v.disponibilidades[mesReferencia])) {
        console.log(`✅ Já preencheu ${mesReferencia}: ${v.nome}`);
        continue;
      }

      const primeiroNome = v.nome.trim().split(" ")[0];

      const html = `
        <div style="font-family:'Segoe UI',sans-serif; max-width:520px; margin:0 auto; background:#f8fafc; padding:24px; border-radius:12px;">
          <div style="background:#1e293b; padding:24px; border-radius:10px; text-align:center; margin-bottom:24px;">
            <img src="https://static.wixstatic.com/media/e5be25_5d5b39f3cd494d41a7b001a04be2673f~mv2.png/v1/fill/w_428,h_88,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Logo_Branco.png"
                 alt="Nação Santa" style="height:50px; object-fit:contain; margin-bottom:12px;">
            <h2 style="color:white; margin:0; font-size:20px;">⏰ Lembrete de Disponibilidade</h2>
            <p style="color:#94a3b8; margin:6px 0 0 0; font-size:14px;">${nomeMesSeguinte} ${anoRef} — Nação Santa</p>
          </div>
          <p style="color:#1e293b; font-size:16px; margin-bottom:4px;">Olá, <b>${primeiroNome}</b>! 👋</p>
          <p style="color:#475569; font-size:14px; line-height:1.6; margin-bottom:20px;">
            Ainda não identificamos seu cadastro de disponibilidade para <b>${nomeMesSeguinte}</b>.
            Para que possamos montar a escala do próximo mês, precisamos saber seus dias disponíveis!
          </p>
          <div style="background:#fef9c3; border:1px solid #fde68a; border-radius:10px; padding:16px; margin-bottom:20px;">
            <p style="color:#92400e; font-size:14px; margin:0; text-align:center;">
              ⚠️ <b>Prazo:</b> Preencha sua disponibilidade ainda hoje para garantir seu lugar na escala de ${nomeMesSeguinte}!
            </p>
          </div>
          <div style="text-align:center; margin-bottom:24px;">
            <a href="https://escala-projecao.web.app"
               style="display:inline-block; background:#2563eb; color:white; padding:14px 32px;
                      border-radius:8px; font-size:15px; font-weight:bold; text-decoration:none;">
              📋 Preencher minha disponibilidade
            </a>
          </div>
          <p style="color:#475569; font-size:13px; line-height:1.6; margin-bottom:20px;">
            O preenchimento é rápido! Informe seus dias disponíveis, datas que não poderá comparecer
            e seus ministérios de atuação.
          </p>
          <div style="background:#f0fdf4; border:1px solid #bbf7d0; border-radius:10px; padding:16px; text-align:center; margin-bottom:20px;">
            <p style="color:#15803d; font-size:14px; margin:0;">
              🙏 Obrigado por fazer parte da equipe! Seu serviço é muito importante para nós.
            </p>
          </div>
          <p style="color:#94a3b8; font-size:11px; text-align:center; margin:0;">
            Enviado automaticamente pelo sistema de escala — Nação Santa
          </p>
        </div>`;

      try {
        await enviarEmail(
          v.email.trim(),
          v.nome.trim(),
          `⏰ Lembre-se: Preencha sua disponibilidade de ${nomeMesSeguinte} | Nação Santa`,
          html
        );
        enviados++;
        console.log(`✅ Lembrete de disponibilidade enviado para ${v.nome} (${v.email})`);
      } catch (errEmail) {
        falhas++;
        console.error(`❌ Falha ao enviar para ${v.nome}:`, errEmail.message);
      }
    }

    console.log(`Lembrete de disponibilidade concluído. Enviados: ${enviados} | Falhas: ${falhas} | Sem e-mail: ${semEmail}`);
  } catch (error) {
    console.error("Erro no lembrete de disponibilidade:", error);
  }
}

// Cron-job chama esta rota todo dia — a função decide sozinha se é o último dia do mês
app.get("/disparar-lembrete-disponibilidade", (req, res) => {
  res.sendStatus(200);
  dispararLembreteDisponibilidade();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
