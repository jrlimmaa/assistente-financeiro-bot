import express from "express";
import TelegramBot from "node-telegram-bot-api";
import { createClient } from "@supabase/supabase-js";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

const app = express();
app.use(express.json());

// =========================
// 🔌 CONEXÕES
// =========================

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const usuarios = {
  8823110547: "Emanuelly",
  1325366143: "Junior"
};

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// =========================
// 🧠 IA
// =========================

const SYSTEM_PROMPT = `
Você é um assistente financeiro.

Transforme mensagens em JSON.

Se for gasto:
{
  "type": "gasto",
  "descricao": "",
  "categoria": "",
  "valor": number
}

Se for receita:
{
  "type": "receita",
  "descricao": "",
  "valor": number,
  "recorrente": boolean
}

Se for consulta:
{
  "type": "consulta"
}

Categorias:
alimentacao, transporte, lazer, mercado, contas, saude, outros.

Responda APENAS JSON válido.
`;

async function interpretar(texto) {
  const res = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: texto }
    ]
  });

  return JSON.parse(res.choices[0].message.content);
}

// =========================
// 💰 SALDO
// =========================

async function saldoTotal(chatId) {
  const usuario = usuarios[chatId];

  const { data: gastos } = await supabase
    .from("gastos")
    .select("*")
    .eq("usuario", usuario);

  const { data: receitas } = await supabase
    .from("receitas")
    .select("*")
    .eq("usuario", usuario);

  const totalGastos = (gastos || []).reduce((a, b) => a + Number(b.valor), 0);
  const totalReceitas = (receitas || []).reduce((a, b) => a + Number(b.valor), 0);

  return {
    gastos: totalGastos,
    receitas: totalReceitas,
    saldo: totalReceitas - totalGastos
  };
}

// =========================
// 💸 SALÁRIO RECORRENTE
// =========================

async function processarSalarioRecorrente() {
  const hoje = new Date().getDate();

  if (hoje !== 1) return;

  for (const chatId in usuarios) {
    const usuario = usuarios[chatId];

    const { data: salarios } = await supabase
      .from("receitas")
      .select("*")
      .eq("usuario", usuario)
      .eq("recorrente", true);

    for (const s of salarios || []) {
      await supabase.from("receitas").insert({
        usuario,
        descricao: s.descricao,
        valor: s.valor,
        recorrente: true
      });
    }

    bot.sendMessage(chatId, "💰 Salário recorrente processado!");
  }
}

// =========================
// ⚠️ ALERTA DE RISCO
// =========================

async function alertaRisco() {
  for (const chatId in usuarios) {
    const usuario = usuarios[chatId];

    const { data: gastos } = await supabase
      .from("gastos")
      .select("*")
      .eq("usuario", usuario);

    const { data: receitas } = await supabase
      .from("receitas")
      .select("*")
      .eq("usuario", usuario);

    const totalGastos = (gastos || []).reduce((a, b) => a + Number(b.valor), 0);
    const totalReceitas = (receitas || []).reduce((a, b) => a + Number(b.valor), 0);

    const limite = totalReceitas * 0.7;

    if (totalGastos >= limite) {
      bot.sendMessage(chatId, "⚠️ ALERTA: Você já gastou mais de 70% da sua renda!");
    }
  }
}

// =========================
// 📅 RELATÓRIOS
// =========================

async function relatorioMensal() {
  const hoje = new Date().getDate();
  if (hoje !== 23) return;

  for (const chatId in usuarios) {
    const s = await saldoTotal(chatId);

    bot.sendMessage(chatId,
`🧾 RELATÓRIO MENSAL

💰 Receitas: R$ ${s.receitas.toFixed(2)}
📉 Gastos: R$ ${s.gastos.toFixed(2)}
💳 Saldo: R$ ${s.saldo.toFixed(2)}`
    );
  }
}

async function relatorioSemanal() {
  const hoje = new Date().getDay();
  if (hoje !== 0) return;

  for (const chatId in usuarios) {
    const s = await saldoTotal(chatId);

    bot.sendMessage(chatId,
`📅 RELATÓRIO SEMANAL

💰 Receitas: R$ ${s.receitas.toFixed(2)}
📉 Gastos: R$ ${s.gastos.toFixed(2)}
💳 Saldo: R$ ${s.saldo.toFixed(2)}`
    );
  }
}

// =========================
// 🤖 BOT
// =========================

bot.on("message", async (msg) => {
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.toLowerCase();

  try {

    if (text.includes("saldo")) {
      const s = await saldoTotal(chatId);

      return bot.sendMessage(chatId,
`💰 SALDO

📥 ${s.receitas}
📤 ${s.gastos}
💳 ${s.saldo}`
      );
    }

    const data = await interpretar(text);

    const usuario = usuarios[chatId];

    if (data.type === "gasto") {
      await supabase.from("gastos").insert({
        usuario,
        descricao: data.descricao,
        categoria: data.categoria,
        valor: data.valor
      });

      return bot.sendMessage(chatId, "✅ Gasto registrado");
    }

    if (data.type === "receita") {
      await supabase.from("receitas").insert({
        usuario,
        descricao: data.descricao,
        valor: data.valor,
        recorrente: data.recorrente
      });

      return bot.sendMessage(chatId, "💰 Receita registrada");
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "❌ Erro");
  }
});

// =========================
// ⏰ LOOP
// =========================

setInterval(async () => {
  await processarSalarioRecorrente();
  await alertaRisco();
  await relatorioMensal();
  await relatorioSemanal();
}, 60 * 60 * 1000);

// =========================
// 🌐 SERVER
// =========================

app.get("/", (req, res) => res.send("Bot rodando"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Bot rodando");
});
