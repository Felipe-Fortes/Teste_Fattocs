const path = require('path');

let db = null;
let driver = null;

function getDb() {
  if (db) return { db, driver };

  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl) {
    driver = 'pg';
    const { Pool } = require('pg');
    db = new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    return { db, driver };
  }

  driver = 'sqlite';
  const Database = require('better-sqlite3');
  const dbPath = path.join(__dirname, 'tarefas.db');
  db = new Database(dbPath);
  return { db, driver };
}

function sqliteSql(sql) {
  return sql.replace(/\$\d+/g, '?');
}

async function runQueryAsync(sql, params = []) {
  const { db, driver } = getDb();
  if (driver === 'pg') {
    const result = await db.query(sql, params);
    return { rows: result.rows, rowCount: result.rowCount };
  }
  const sqlSqlite = sqliteSql(sql).replace(/RETURNING .+$/i, '').trim();
  const stmt = db.prepare(sqlSqlite);
  stmt.run(...params);
  if (/SELECT/i.test(sql)) {
    const selectStmt = db.prepare(sqlSqlite);
    return { rows: selectStmt.all(...params) };
  }
  return { rows: [] };
}

function initDb() {
  const { db, driver } = getDb();

  if (driver === 'sqlite') {
    db.exec(`
      CREATE TABLE IF NOT EXISTS Tarefas (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nome TEXT NOT NULL UNIQUE,
        custo REAL NOT NULL CHECK (custo >= 0),
        data_limite TEXT NOT NULL,
        ordem INTEGER NOT NULL UNIQUE
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tarefas_nome ON Tarefas(nome);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tarefas_ordem ON Tarefas(ordem);
    `);
    return;
  }

  return (async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS "Tarefas" (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(500) NOT NULL UNIQUE,
        custo DECIMAL(12,2) NOT NULL CHECK (custo >= 0),
        data_limite DATE NOT NULL,
        ordem INTEGER NOT NULL UNIQUE
      )
    `);
  })();
}

async function listarTarefas() {
  const sql = 'SELECT id, nome, custo, data_limite, ordem FROM "Tarefas" ORDER BY ordem ASC';
  const r = await runQueryAsync(sql);
  return r.rows || [];
}

async function proximaOrdem() {
  const { db, driver } = getDb();
  if (driver === 'pg') {
    const r = await db.query('SELECT COALESCE(MAX(ordem), 0) + 1 AS next FROM "Tarefas"');
    return r.rows[0].next;
  }
  const r = db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS next FROM Tarefas').get();
  return r.next;
}

async function proximoIdDisponivel() {
  const { db, driver } = getDb();
  
  // Busca todos os IDs existentes ordenados
  let idsExistentes;
  if (driver === 'pg') {
    const r = await db.query('SELECT id FROM "Tarefas" ORDER BY id ASC');
    idsExistentes = r.rows.map(row => row.id);
  } else {
    idsExistentes = db.prepare('SELECT id FROM Tarefas ORDER BY id ASC').all().map(row => row.id);
  }
  
  // Se não há tarefas, retorna 1
  if (idsExistentes.length === 0) return 1;
  
  // Procura o primeiro gap começando de 1
  let idEsperado = 1;
  for (const id of idsExistentes) {
    if (id !== idEsperado) {
      return idEsperado; // Encontrou um gap
    }
    idEsperado++;
  }
  
  // Não há gaps, retorna o próximo após o último
  return idsExistentes[idsExistentes.length - 1] + 1;
}

async function incluirTarefa(nome, custo, dataLimite) {
  const ordem = await proximaOrdem();
  const proximoId = await proximoIdDisponivel();
  const { db, driver } = getDb();
  
  if (driver === 'pg') {
    const sql = 'INSERT INTO "Tarefas" (id, nome, custo, data_limite, ordem) VALUES ($1, $2, $3, $4, $5) RETURNING id, nome, custo, data_limite, ordem';
    const r = await db.query(sql, [proximoId, nome, custo, dataLimite, ordem]);
    return r.rows[0];
  } else {
    // SQLite
    const sql = 'INSERT INTO Tarefas (id, nome, custo, data_limite, ordem) VALUES (?, ?, ?, ?, ?)';
    db.prepare(sql).run(proximoId, nome, custo, dataLimite, ordem);
    return { id: proximoId, nome, custo, data_limite: dataLimite, ordem };
  }
}

async function excluirTarefa(id) {
  const sql = 'DELETE FROM "Tarefas" WHERE id = $1';
  await runQueryAsync(sql, [id]);
}

async function buscarPorId(id) {
  const sql = 'SELECT id, nome, custo, data_limite, ordem FROM "Tarefas" WHERE id = $1';
  const r = await runQueryAsync(sql, [id]);
  return (r.rows && r.rows[0]) ? r.rows[0] : null;
}

async function nomeExiste(nome, excluirId = null) {
  let sql = 'SELECT 1 FROM "Tarefas" WHERE nome = $1';
  const params = [nome];
  if (excluirId != null) {
    sql += ' AND id != $2';
    params.push(excluirId);
  }
  const r = await runQueryAsync(sql, params);
  return (r.rows && r.rows.length > 0);
}

async function atualizarTarefa(id, nome, custo, dataLimite) {
  const sql = 'UPDATE "Tarefas" SET nome = $1, custo = $2, data_limite = $3 WHERE id = $4';
  await runQueryAsync(sql, [nome, custo, dataLimite, id]);
  return buscarPorId(id);
}

async function reordenar(id, direcao) {
  const lista = await listarTarefas();
  const idx = lista.findIndex(t => t.id == id);
  if (idx < 0) return lista;
  const outroIdx = direcao === 'subir' ? idx - 1 : idx + 1;
  if (outroIdx < 0 || outroIdx >= lista.length) return lista;

  const a = lista[idx];
  const b = lista[outroIdx];
  const { db, driver } = getDb();
  
  // Usar valor temp evitando violação de UNIQUE constraint :P
  const temp = -1;
  
  if (driver === 'pg') {
    await db.query('UPDATE "Tarefas" SET ordem = $1 WHERE id = $2', [temp, a.id]);
    await db.query('UPDATE "Tarefas" SET ordem = $1 WHERE id = $2', [a.ordem, b.id]);
    await db.query('UPDATE "Tarefas" SET ordem = $1 WHERE id = $2', [b.ordem, a.id]);
  } else {
    db.prepare('UPDATE Tarefas SET ordem = ? WHERE id = ?').run(temp, a.id);
    db.prepare('UPDATE Tarefas SET ordem = ? WHERE id = ?').run(a.ordem, b.id);
    db.prepare('UPDATE Tarefas SET ordem = ? WHERE id = ?').run(b.ordem, a.id);
  }
  return listarTarefas();
}

module.exports = {
  initDb,
  listarTarefas,
  incluirTarefa,
  excluirTarefa,
  buscarPorId,
  nomeExiste,
  atualizarTarefa,
  reordenar
};
