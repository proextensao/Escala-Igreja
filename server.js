const express = require("express");
const cors = require("cors");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
app.use(cors());
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
    const amanha = new Date();
    amanha.setUTCHours(amanha.getUTCHours() - 3); // Fuso horário do Brasil
    amanha.setDate(amanha.getDate() + 1); // Calcula o dia de amanhã

    const dd = String(amanha.getDate()).padStart(2, '0');
    const mm = String(amanha.getMonth() + 1).padStart(2, '0');
    const aaaa = amanha.getFullYear();
    const dataAlvo = `${dd}/${mm}/${aaaa}`; // Fica no formato exato da sua tabela: 13/06/2026
    const mesRef = `${aaaa}-${mm}`;

    // Busca as escalas salvas do mês atual
    const escalasSnap = await db.collection("historico_escalas").where("mesReferencia", "==", mesRef).get();
    
    // Busca os e-mails dos voluntários
    const volSnap = await db.collection("voluntarios").get();
    const emailMap = {};
    volSnap.forEach(d => {
      const v = d.data();
      if (v.nome && v.email) emailMap[v.nome] = v.email;
    });

    escalasSnap.forEach(doc => {
      const escala = doc.data();
      escala.linhas.forEach(async (linha) => {
        // Se a data do evento for amanhã...
        if (linha.data === dataAlvo && linha.voluntario && linha.voluntario !== "A definir") {
          const email = emailMap[linha.voluntario];
          if (email) {
            const primeiroNome = linha.voluntario.split(" ")[0];
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
            await enviarEmail(email, linha.voluntario, assunto, html);
            console.log(`Lembrete automático enviado para ${linha.voluntario}`);
          }
        }
      });
    });
  } catch (error) {
    console.error("Erro no lembrete automático:", error);
  }
}

// Endpoint para disparar o lembrete (O Render usará isso)
app.get("/disparar-lembretes-diarios", async (req, res) => {
  await dispararLembretesDeAmanha();
  res.send("Verificação de lembretes rodada com sucesso!");
});

// ── Health check ──
app.get("/", (req, res) => res.send("Servidor de escala Nação Santa — ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
