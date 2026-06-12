const express = require("express");
const cors = require("cors");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const app = express();
app.use(cors());
app.use(express.json());

// ── Firebase Admin ────────────────────────────────────────────────────────
initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
});

const db = getFirestore();

// ── Brevo ─────────────────────────────────────────────────────────────────
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

// ── Helper: mês por extenso ───────────────────────────────────────────────
const MESES = [
  "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro",
];

function mesExtenso(mesRef) {
  // mesRef formato: "2025-07"
  const [, m] = mesRef.split("-");
  return MESES[parseInt(m) - 1];
}

// ── Endpoint: enviar lembretes da escala ──────────────────────────────────
// Body: { historicoId: "abc123" }
app.post("/enviar-lembretes", async (req, res) => {
  const { historicoId } = req.body;

  if (!historicoId) {
    return res.status(400).json({ erro: "historicoId é obrigatório" });
  }

  try {
    // 1. Busca a escala no Firestore
    const snap = await db.collection("historico_escalas").doc(historicoId).get();
    if (!snap.exists) {
      return res.status(404).json({ erro: "Escala não encontrada" });
    }

    const escala = snap.data();
    const { ministerio, mesReferencia, linhas, nomeExibicao } = escala;
    const mesNome = mesExtenso(mesReferencia);
    const ano = mesReferencia.split("-")[0];

    // 2. Agrupa linhas por voluntário
    const porVoluntario = {}; // { "Nome Completo": [{data, evento, hora}, ...] }
    for (const linha of linhas) {
      if (!linha.voluntario) continue;
      if (!porVoluntario[linha.voluntario]) porVoluntario[linha.voluntario] = [];
      porVoluntario[linha.voluntario].push(linha);
    }

    // 3. Busca e-mails dos voluntários no Firestore
    const volSnap = await db.collection("voluntarios").get();
    const emailMap = {}; // { "Nome Completo": { email, nome } }
    volSnap.forEach((d) => {
      const v = d.data();
      if (v.nome && v.email) emailMap[v.nome] = { email: v.email, nome: v.nome };
    });

    // 4. Envia um e-mail para cada voluntário escalado
    const resultados = [];
    for (const [nomeVol, dias] of Object.entries(porVoluntario)) {
      const volInfo = emailMap[nomeVol];
      if (!volInfo || !volInfo.email) {
        resultados.push({ nome: nomeVol, status: "sem_email" });
        continue;
      }

      // Ordena os dias cronologicamente
      dias.sort((a, b) => {
        const toISO = (d) => {
          const p = d.split("/");
          return p.length === 3 ? `${p[2]}-${p[1].padStart(2,"0")}-${p[0].padStart(2,"0")}` : d;
        };
        return toISO(a.data).localeCompare(toISO(b.data));
      });

      const diasHtml = dias
        .map((l) => {
          const [d, m] = l.data.split("/");
          return `
            <tr>
              <td style="padding:10px 14px; border-bottom:1px solid #f1f5f9; font-weight:bold; color:#1e293b;">${d}/${m}</td>
              <td style="padding:10px 14px; border-bottom:1px solid #f1f5f9; color:#475569;">${l.evento}</td>
              <td style="padding:10px 14px; border-bottom:1px solid #f1f5f9; color:#475569;">${l.hora}</td>
            </tr>`;
        })
        .join("");

      const primeiroNome = nomeVol.split(" ")[0];

      const html = `
        <div style="font-family:'Segoe UI',sans-serif; max-width:520px; margin:0 auto; background:#f8fafc; padding:24px; border-radius:12px;">

          <div style="background:#1e293b; padding:24px; border-radius:10px; text-align:center; margin-bottom:24px;">
            <img src="https://static.wixstatic.com/media/e5be25_5d5b39f3cd494d41a7b001a04be2673f~mv2.png/v1/fill/w_428,h_88,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Logo_Branco.png"
                 alt="Nação Santa" style="height:50px; object-fit:contain; margin-bottom:12px;">
            <h2 style="color:white; margin:0; font-size:20px;">📅 Sua Escala de ${mesNome}</h2>
            <p style="color:#94a3b8; margin:6px 0 0 0; font-size:14px;">${ministerio} — Nação Santa</p>
          </div>

          <p style="color:#1e293b; font-size:16px; margin-bottom:4px;">Olá, <b>${primeiroNome}</b>! 👋</p>
          <p style="color:#475569; font-size:14px; margin-bottom:20px;">
            Aqui estão os seus dias de escala em <b>${mesNome} ${ano}</b> no ministério de <b>${ministerio}</b>:
          </p>

          <div style="background:white; border-radius:10px; overflow:hidden; margin-bottom:20px; box-shadow:0 2px 8px rgba(0,0,0,0.07);">
            <table style="width:100%; border-collapse:collapse;">
              <thead>
                <tr style="background:#2563eb; color:white;">
                  <th style="padding:10px 14px; text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Data</th>
                  <th style="padding:10px 14px; text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Evento</th>
                  <th style="padding:10px 14px; text-align:left; font-size:12px; text-transform:uppercase; letter-spacing:0.5px;">Hora</th>
                </tr>
              </thead>
              <tbody>${diasHtml}</tbody>
            </table>
          </div>

          <div style="background:#eff6ff; border:1px solid #bfdbfe; border-radius:10px; padding:16px; text-align:center; margin-bottom:20px;">
            <p style="color:#1d4ed8; font-size:14px; margin:0;">
              🙏 Obrigado por servir! Que Deus abençoe o seu ministério.
            </p>
          </div>

          <p style="color:#94a3b8; font-size:11px; text-align:center; margin:0;">
            Enviado automaticamente pelo sistema de escala — Nação Santa
          </p>
        </div>`;

      try {
        await enviarEmail(
          volInfo.email,
          volInfo.nome,
          `📅 Sua escala de ${mesNome} ${ano} — ${ministerio} | Nação Santa`,
          html
        );
        resultados.push({ nome: nomeVol, status: "enviado", email: volInfo.email });
      } catch (err) {
        resultados.push({ nome: nomeVol, status: "erro", detalhe: err.message });
      }
    }

    res.json({ ok: true, mesReferencia, ministerio, resultados });
  } catch (err) {
    console.error(err);
    res.status(500).json({ erro: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────
app.get("/", (req, res) => res.send("Servidor de escala Nação Santa — ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
