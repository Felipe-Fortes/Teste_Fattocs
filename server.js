const express = require('express');
const cors = require('cors');
const path = require('path');
const Decimal = require('decimal.js');
const db = require('./db');

// Constante para o máximo de dígitos permitido (15 dígitos = mais que isso o java bugga)
const MAX_CUSTO_DIGITS = 15;
const MAX_CUSTO_VALUE = new Decimal('999999999999999'); // 15 noves

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function parseDataBr(str) {
  const m = str && str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mes = parseInt(m[2], 10) - 1;
  const a = parseInt(m[3], 10);
  const date = new Date(a, mes, d);
  if (date.getDate() !== d || date.getMonth() !== mes || date.getFullYear() !== a) return null;
  return date;
}

function formatDataBr(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
}

function validarCusto(custoStr) {
  try {
    let custoTrimmed = String(custoStr).trim();
    custoTrimmed = custoTrimmed.replace(/\./g, '');
    custoTrimmed = custoTrimmed.replace(',', '.'); 
    
    const decimal = new Decimal(custoTrimmed);
    
    // Validar se é número válido e não negativo
    if (decimal.isNaN() || decimal.isNegative()) {
      return { valido: false, erro: 'Custo deve ser um número não-negativo.' };
    }
    
    // Valida se n passa dos limites
    if (decimal.greaterThan(MAX_CUSTO_VALUE)) {
      return { 
        valido: false, 
        erro: `Custo não pode exceder ${MAX_CUSTO_VALUE.toString()} (máximo ${MAX_CUSTO_DIGITS} dígitos).` 
      };
    }
    
    // Converter o numero
    const numeroSeguro = decimal.toNumber();
    return { valido: true, valor: numeroSeguro, decimal: decimal };
  } catch (e) {
    return { valido: false, erro: 'Custo deve ser um número válido.' };
  }
}

async function init() {
  const result = db.initDb();
  if (result && typeof result.then === 'function') {
    await result;
  }
}

app.get('/api/tarefas', async (req, res) => {
  try {
    const tarefas = await db.listarTarefas();
    const formatadas = tarefas.map(t => ({
      id: t.id,
      nome: t.nome,
      custo: Number(t.custo),
      data_limite: formatDataBr(t.data_limite),
      ordem: t.ordem
    }));
    res.json(formatadas);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/api/tarefas', async (req, res) => {
  try {
    const { nome, custo, data_limite } = req.body || {};
    if (!nome || typeof nome !== 'string' || !nome.trim()) {
      return res.status(400).json({ erro: 'Nome da tarefa é obrigatório.' });
    }
    
    const validacaoCusto = validarCusto(custo);
    if (!validacaoCusto.valido) {
      return res.status(400).json({ erro: validacaoCusto.erro });
    }
    const custoNum = validacaoCusto.valor;
    
    const data = parseDataBr(String(data_limite || '').trim());
    if (!data) {
      return res.status(400).json({ erro: 'Data-limite inválida. Use DD/MM/AAAA.' });
    }
    const dataIso = data.toISOString().slice(0, 10);
    const existe = await db.nomeExiste(nome.trim());
    if (existe) {
      return res.status(400).json({ erro: 'Já existe uma tarefa com este nome.' });
    }
    const tarefa = await db.incluirTarefa(nome.trim(), custoNum, dataIso);
    res.status(201).json({
      id: tarefa.id,
      nome: tarefa.nome,
      custo: Number(tarefa.custo),
      data_limite: formatDataBr(tarefa.data_limite),
      ordem: tarefa.ordem
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.put('/api/tarefas/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { nome, custo, data_limite } = req.body || {};
    const atual = await db.buscarPorId(id);
    if (!atual) {
      return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    }
    if (!nome || typeof nome !== 'string' || !nome.trim()) {
      return res.status(400).json({ erro: 'Nome da tarefa é obrigatório.' });
    }
    
    const validacaoCusto = validarCusto(custo);
    if (!validacaoCusto.valido) {
      return res.status(400).json({ erro: validacaoCusto.erro });
    }
    const custoNum = validacaoCusto.valor;
    
    const data = parseDataBr(String(data_limite || '').trim());
    if (!data) {
      return res.status(400).json({ erro: 'Data-limite inválida. Use DD/MM/AAAA.' });
    }
    const dataIso = data.toISOString().slice(0, 10);
    const existe = await db.nomeExiste(nome.trim(), id);
    if (existe) {
      return res.status(400).json({ erro: 'Já existe uma tarefa com este nome.' });
    }
    const tarefa = await db.atualizarTarefa(id, nome.trim(), custoNum, dataIso);
    res.json({
      id: tarefa.id,
      nome: tarefa.nome,
      custo: Number(tarefa.custo),
      data_limite: formatDataBr(tarefa.data_limite),
      ordem: tarefa.ordem
    });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/api/tarefas/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const atual = await db.buscarPorId(id);
    if (!atual) {
      return res.status(404).json({ erro: 'Tarefa não encontrada.' });
    }
    await db.excluirTarefa(id);
    res.status(204).end();
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.patch('/api/tarefas/:id/reordenar', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { direcao } = req.body || {};
    if (direcao !== 'subir' && direcao !== 'descer') {
      return res.status(400).json({ erro: 'Direção deve ser "subir" ou "descer".' });
    }
    const tarefas = await db.reordenar(id, direcao);
    const formatadas = tarefas.map(t => ({
      id: t.id,
      nome: t.nome,
      custo: Number(t.custo),
      data_limite: formatDataBr(t.data_limite),
      ordem: t.ordem
    }));
    res.json(formatadas);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

const PORT = process.env.PORT || 3000;
init()
  .then(() => {
    app.listen(PORT, () => {
      console.log('Servidor em http://localhost:' + PORT);
    });
  })
  .catch((err) => {
    console.error('Erro ao inicializar banco:', err);
    process.exit(1);
  });
