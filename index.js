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
// 📋 CONFIGURAR COMANDOS DO BOT
// =========================
(async () => {
  await bot.setMyCommands([
    { command: "saldo", description: "Ver seu saldo individual" },
    { command: "geral", description: "Ver saldo geral (Junior + Emanuelly)" },
    { command: "cartao", description: "Ver gastos de um cartão específico (ex: /cartao Visa)" },
    { command: "gasto", description: "Registrar um novo gasto (ex: /gasto 50 almoço)" },
    { command: "receita", description: "Registrar uma nova receita (ex: /receita 200 salário)" },
    // Podemos adicionar mais depois
  ]);
})();

// =========================
// 🧠 IA PROMPT
// =========================

const SYSTEM_PROMPT = `
Você é um assistente financeiro.

Transforme mensagens em JSON válido.

Se for gasto:
{
  "type": "gasto",
  "descricao": "",
  "categoria": "",
  "valor": number,
  "forma_pagamento": "pix | dinheiro | cartao_credito",
  "cartao": "",
  "parcelado": boolean,
  "parcelas": number
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

REGRAS:
- Se não falar pagamento → assumir "pix"
- PIX e dinheiro = "pix"
- Só usar cartão se citado explicitamente
- Parcelas: se não falar → 1

Responda APENAS JSON válido.
`;

// =========================
// 🧠 IA
// =========================

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
// 👥 SALDO GERAL (Júnior + Emanuelly)
// =========================

async function saldoGeral() {
  let resposta = `📊 SALDO GERAL\n\n`;
  let totalGastos = 0;
  let totalReceitas = 0;

  for (const [id, nome] of Object.entries(usuarios)) {
    const { data: g } = await supabase
      .from("gastos")
      .select("valor")
      .eq("usuario", nome);

    const { data: r } = await supabase
      .from("receitas")
      .select("valor")
      .eq("usuario", nome);

    const gastos = (g || []).reduce((s, i) => s + Number(i.valor || 0), 0);
    const receitas = (r || []).reduce((s, i) => s + Number(i.valor || 0), 0);
    const saldo = receitas - gastos;

    resposta += `👤 ${nome}\n📥 Receitas: R$ ${receitas.toFixed(2)}\n📤 Gastos: R$ ${gastos.toFixed(2)}\n💵 Saldo: R$ ${saldo.toFixed(2)}\n\n`;

    totalReceitas += receitas;
    totalGastos += gastos;
  }

  resposta += `💳 TOTAL CONSOLIDADO\n📥 Receitas: R$ ${totalReceitas.toFixed(2)}\n📤 Gastos: R$ ${totalGastos.toFixed(2)}\n💰 Saldo: R$ ${(totalReceitas - totalGastos).toFixed(2)}`;

  return resposta;
}

// =========================
// 💳 GASTOS POR CARTÃO
// =========================

async function gastosPorCartao(chatId, cartaoNome) {
  const usuario = usuarios[chatId];

  const { data } = await supabase
    .from("gastos")
    .select("descricao, valor, parcelas")
    .eq("usuario", usuario)
    .eq("cartao", cartaoNome);

  if (!data || data.length === 0) {
    return `💳 Nenhum gasto encontrado no cartão ${cartaoNome}`;
  }

  let total = 0;
  const lista = data.map(g => {
    total += Number(g.valor);
    return `• ${g.descricao} - R$ ${g.valor} (${g.parcelas}x)`;
  }).join("\n");

  return `💳 CARTÃO: ${cartaoNome}

${lista}

💰 TOTAL: R$ ${total.toFixed(2)}`;
}

// =========================
// 🤖 BOT – COMANDOS
// =========================

// Usuário não reconhecido pode mandar mensagem
bot.on("message", async (msg) => {
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text; // sem toLowerCase para preservar comandos

  // Verificar se é um comando (entidade bot_command)
  const isCommand = msg.entities && msg.entities.some(e => e.type === 'bot_command');
  
  // Se for um comando, processamos aqui e não passamos para a IA
  if (isCommand) {
    const command = text.split(' ')[0].substring(1).toLowerCase(); // remove a '/'
    const args = text.substring(command.length + 1).trim(); // texto após o comando

    try {
      if (command === 'saldo') {
        const s = await saldoTotal(chatId);
        return bot.sendMessage(chatId,
`💰 SALDO (${usuarios[chatId]})

📥 Receitas: ${s.receitas.toFixed(2)}
📤 Gastos: ${s.gastos.toFixed(2)}
💳 Saldo: ${s.saldo.toFixed(2)}`
        );
      }

      if (command === 'geral') {
        const resposta = await saldoGeral();
        return bot.sendMessage(chatId, resposta);
      }

      if (command === 'cartao') {
        if (!args) {
          return bot.sendMessage(chatId, "❌ Use: /cartao NomeDoCartao");
        }
        const resposta = await gastosPorCartao(chatId, args);
        return bot.sendMessage(chatId, resposta);
      }

      if (command === 'gasto') {
        // Exemplo rápido: /gasto 50 almoço
        if (!args) {
          return bot.sendMessage(chatId, "❌ Use: /gasto valor descrição");
        }
        const parts = args.split(' ');
        const valor = parseFloat(parts[0]);
        if (isNaN(valor)) return bot.sendMessage(chatId, "❌ Valor inválido.");
        const descricao = parts.slice(1).join(' ') || 'sem descrição';
        await supabase.from("gastos").insert({
          usuario: usuarios[chatId],
          descricao,
          categoria: "outros",
          valor,
          forma_pagamento: "pix",
          parcelado: false,
          parcelas: 1,
          cartao: null
        });
        return bot.sendMessage(chatId, `✅ Gasto registrado: ${descricao} - R$ ${valor.toFixed(2)}`);
      }

      if (command === 'receita') {
        if (!args) {
          return bot.sendMessage(chatId, "❌ Use: /receita valor descrição");
        }
        const parts = args.split(' ');
        const valor = parseFloat(parts[0]);
        if (isNaN(valor)) return bot.sendMessage(chatId, "❌ Valor inválido.");
        const descricao = parts.slice(1).join(' ') || 'sem descrição';
        await supabase.from("receitas").insert({
          usuario: usuarios[chatId],
          descricao,
          valor,
          recorrente: false
        });
        return bot.sendMessage(chatId, `💰 Receita registrada: ${descricao} - R$ ${valor.toFixed(2)}`);
      }

      // Comando não reconhecido
      return bot.sendMessage(chatId, "❓ Comando não reconhecido.");
    } catch (err) {
      console.error(err);
      return bot.sendMessage(chatId, "❌ Erro ao processar comando.");
    }
  }

  // =========================
  // MENSAGENS NORMAIS (interpretação por IA)
  // =========================
  try {
    const textLower = text.toLowerCase();

    // Ainda mantemos atalhos por texto para quem prefere
    if (textLower.includes("saldo geral") || textLower === "geral") {
      const resposta = await saldoGeral();
      return bot.sendMessage(chatId, resposta);
    }

    if (textLower.includes("saldo")) {
      const s = await saldoTotal(chatId);
      return bot.sendMessage(chatId,
`💰 SALDO (${usuarios[chatId]})

📥 Receitas: ${s.receitas.toFixed(2)}
📤 Gastos: ${s.gastos.toFixed(2)}
💳 Saldo: ${s.saldo.toFixed(2)}`
      );
    }

    if (textLower.startsWith("cartao ")) {
      const cartao = text.replace(/^cartao\s+/i, "").trim();
      const resposta = await gastosPorCartao(chatId, cartao);
      return bot.sendMessage(chatId, resposta);
    }

    // 🧠 IA
    const data = await interpretar(text);
    const usuario = usuarios[chatId];

    if (data.type === "gasto") {
      await supabase.from("gastos").insert({
        usuario,
        descricao: data.descricao,
        categoria: data.categoria || "outros",
        valor: data.valor || 0,
        forma_pagamento: data.forma_pagamento || "pix",
        cartao: data.cartao || null,
        parcelado: data.parcelado || false,
        parcelas: data.parcelas || 1
      });

      return bot.sendMessage(chatId, "✅ Gasto registrado");
    }

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
