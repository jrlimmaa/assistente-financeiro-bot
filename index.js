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
// 🧠 IA PROMPT (MELHORADO)
// =========================

const SYSTEM_PROMPT = `
Você é um assistente financeiro.

Você pode retornar:

1) Gasto único:
{
  "type": "gasto",
  "descricao": "",
  "categoria": "",
  "valor": number
}

2) LISTA DE GASTOS (fatura/extrato):
[
  {
    "type": "gasto",
    "descricao": "",
    "categoria": "",
    "valor": number
  }
]

3) Receita:
{
  "type": "receita",
  "descricao": "",
  "valor": number,
  "recorrente": boolean
}

4) Consulta:
{
  "type": "consulta"
}

Categorias:
alimentacao, transporte, lazer, mercado, contas, saude, outros.

Responda SOMENTE JSON válido.
`;

async function interpretar(texto) {
  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: texto }
      ]
    });

    return JSON.parse(res.choices[0].message.content);
  } catch (e) {
    return { type: "erro" };
  }
}

// =========================
// 💰 SALDO INDIVIDUAL
// =========================

async function saldoTotal(chatId) {
  const usuario = usuarios[chatId];

  const { data: gastos } = await supabase
    .from("gastos")
    .select("valor")
    .eq("usuario", usuario);

  const { data: receitas } = await supabase
    .from("receitas")
    .select("valor")
    .eq("usuario", usuario);

  const totalGastos = (gastos || []).reduce((a, b) => a + Number(b.valor || 0), 0);
  const totalReceitas = (receitas || []).reduce((a, b) => a + Number(b.valor || 0), 0);

  return {
    gastos: totalGastos,
    receitas: totalReceitas,
    saldo: totalReceitas - totalGastos
  };
}

// =========================
// 👥 SALDO GERAL
// =========================

async function saldoGeral() {
  let totalReceitas = 0;
  let totalGastos = 0;

  for (const id in usuarios) {
    const usuario = usuarios[id];

    const { data: gastos } = await supabase
      .from("gastos")
      .select("valor")
      .eq("usuario", usuario);

    const { data: receitas } = await supabase
      .from("receitas")
      .select("valor")
      .eq("usuario", usuario);

    totalGastos += (gastos || []).reduce((a, b) => a + Number(b.valor || 0), 0);
    totalReceitas += (receitas || []).reduce((a, b) => a + Number(b.valor || 0), 0);
  }

  return `
👥 SALDO GERAL

💰 Receitas: R$ ${totalReceitas.toFixed(2)}
📉 Gastos: R$ ${totalGastos.toFixed(2)}
💳 Saldo: R$ ${(totalReceitas - totalGastos).toFixed(2)}
`;
}

// =========================
// 📊 CATEGORIAS
// =========================

async function categorias(chatId) {
  const usuario = usuarios[chatId];

  const { data } = await supabase
    .from("gastos")
    .select("categoria, valor")
    .eq("usuario", usuario);

  if (!data || data.length === 0) {
    return `📊 Nenhum gasto encontrado para ${usuario}`;
  }

  const resumo = {};

  data.forEach(item => {
    const cat = item.categoria || "outros";
    resumo[cat] = (resumo[cat] || 0) + Number(item.valor || 0);
  });

  const msg = Object.entries(resumo)
    .map(([cat, val]) => `• ${cat}: R$ ${val.toFixed(2)}`)
    .join("\n");

  return `📊 GASTOS POR CATEGORIA (${usuario})

${msg}`;
}

// =========================
// 🤖 BOT (COM FATURA MULTI-ITEM)
// =========================

bot.on("message", async (msg) => {
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.toLowerCase();

  try {

    if (text.includes("saldo geral")) {
      const msg = await saldoGeral();
      return bot.sendMessage(chatId, msg);
    }

    if (text.includes("categorias")) {
      const msg = await categorias(chatId);
      return bot.sendMessage(chatId, msg);
    }

    if (text.includes("saldo")) {
      const s = await saldoTotal(chatId);

      return bot.sendMessage(chatId,
`💰 SALDO (${usuarios[chatId]})

📥 Receitas: ${s.receitas.toFixed(2)}
📤 Gastos: ${s.gastos.toFixed(2)}
💳 Saldo: ${s.saldo.toFixed(2)}`
      );
    }

    const data = await interpretar(text);
    const usuario = usuarios[chatId];

    // =========================
    // 💥 CASO 1: LISTA DE GASTOS (FATURA)
    // =========================
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.type === "gasto") {
          await supabase.from("gastos").insert({
            usuario,
            descricao: item.descricao,
            categoria: item.categoria || "outros",
            valor: item.valor || 0
          });
        }
      }

      return bot.sendMessage(chatId, "✅ Fatura processada com sucesso");
    }

    // =========================
    // 💸 GASTO ÚNICO
    // =========================
    if (data.type === "gasto") {
      await supabase.from("gastos").insert({
        usuario,
        descricao: data.descricao,
        categoria: data.categoria || "outros",
        valor: data.valor || 0
      });

      return bot.sendMessage(chatId, "✅ Gasto registrado");
    }

    // =========================
    // 💰 RECEITA
    // =========================
    if (data.type === "receita") {
      await supabase.from("receitas").insert({
        usuario,
        descricao: data.descricao,
        valor: data.valor || 0,
        recorrente: data.recorrente || false
      });

      return bot.sendMessage(chatId, "💰 Receita registrada");
    }

  } catch (err) {
    console.error(err);
    bot.sendMessage(chatId, "❌ Erro ao processar");
  }
});

// =========================
// 🌐 SERVER
// =========================

app.get("/", (req, res) => res.send("Bot rodando"));

app.listen(process.env.PORT || 3000, () => {
  console.log("Bot rodando");
});
