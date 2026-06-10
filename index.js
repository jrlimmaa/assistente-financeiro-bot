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

const usuarios = [
  8823110547,
  1325366143
];

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
  const { data: gastos } = await supabase
    .from("gastos")
    .select("*")
    .eq("usuario", String(chatId));

  const { data: receitas } = await supabase
    .from("receitas")
    .select("*")
    .eq("usuario", String(chatId));

  const totalGastos = (gastos || []).reduce((a, b) => a + Number(b.valor), 0);
  const totalReceitas = (receitas || []).reduce((a, b) => a + Number(b.valor), 0);

  return {
    gastos: totalGastos,
    receitas: totalReceitas,
    saldo: totalReceitas - totalGastos
  };
}

// =========================
// 📊 LIMITE INTELIGENTE
// =========================

async function limiteInteligente(chatId) {
  const saldo = await saldoTotal(chatId);

  const limiteDiario = saldo.saldo / 30;

  return {
    limiteDiario,
    alerta: limiteDiario < 20 ? "⚠️ Orçamento muito apertado" : "✅ Saudável"
  };
}

// =========================
// 💸 SALÁRIO RECORRENTE AUTOMÁTICO
// =========================

async function processarSalarioRecorrente() {
  const hoje = new Date().getDate();

  if (hoje !== 1) return; // todo dia 1

  for (const chatId of usuarios) {

    const { data: salarios } = await supabase
      .from("receitas")
      .select("*")
      .eq("usuario", String(chatId))
      .eq("recorrente", true);

    for (const s of salarios || []) {
      await supabase.from("receitas").insert({
        usuario: chatId,
        descricao: s.descricao,
        valor: s.valor,
        recorrente: true
      });
    }

    bot.sendMessage(chatId, "💰 Salário recorrente processado do mês!");
  }
}

// =========================
// ⚠️ ALERTA DE RISCO
// =========================

async function alertaRisco() {
  for (const chatId of usuarios) {
    const saldo = await saldoTotal(chatId);

    const limite = saldo.receitas * 0.7;

    if (saldo.gastos >= limite) {
      bot.sendMessage(
        chatId,
        "⚠️ ALERTA: Você já gastou mais de 70% da sua renda do mês!"
      );
    }
  }
}

// =========================
// 📅 RELATÓRIO MENSAL (DIA 23)
// =========================

async function relatorioMensal() {
  const hoje = new Date().getDate();
  if (hoje !== 23) return;

  for (const chatId of usuarios) {
    const saldo = await saldoTotal(chatId);

    bot.sendMessage(
      chatId,
      `🧾 RELATÓRIO MENSAL

💰 Receitas: R$ ${saldo.receitas.toFixed(2)}
📉 Gastos: R$ ${saldo.gastos.toFixed(2)}
💳 Saldo: R$ ${saldo.saldo.toFixed(2)}`
    );
  }
}

// =========================
// 📅 RELATÓRIO SEMANAL (DOMINGO)
// =========================

async function relatorioSemanal() {
  const hoje = new Date().getDay();
  if (hoje !== 0) return;

  for (const chatId of usuarios) {
    const saldo = await saldoTotal(chatId);

    bot.sendMessage(
      chatId,
      `📅 RELATÓRIO SEMANAL

💰 Receitas: R$ ${saldo.receitas.toFixed(2)}
📉 Gastos: R$ ${saldo.gastos.toFixed(2)}
💳 Saldo: R$ ${saldo.saldo.toFixed(2)}`
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
        `💰 SALDO\n\n📥 ${s.receitas}\n📤 ${s.gastos}\n💳 ${s.saldo}`
      );
    }

    const data = await interpretar(text);

    if (data.type === "gasto") {
      await supabase.from("gastos").insert({
        usuario: String(chatId),
        descricao: data.descricao,
        categoria: data.categoria,
        valor: data.valor
      });

      return bot.sendMessage(chatId, "✅ Gasto registrado");
    }

    if (data.type === "receita") {
      await supabase.from("receitas").insert({
        usuario: String(chatId),
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
// ⏰ LOOP AUTOMÁTICO
// =========================

setInterval(async () => {
  await processarSalarioRecorrente();
  await alertaRisco();
  await relatorioMensal();
  await relatorioSemanal();
}, 60 * 60 * 1000); // 1h

// =========================
// 🌐 SERVER
// =========================

app.get("/", (req, res) => res.send("Bot rodando"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Bot rodando");
});