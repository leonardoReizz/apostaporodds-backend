import { MongoClient } from 'mongodb';
import env from './env/index.js';

const BETS_DATABASE_URL = env.BETS_DATABASE_URL || process.env.BETS_DATABASE_URL;

if (!BETS_DATABASE_URL) {
  console.warn('[MongoDB] BETS_DATABASE_URL não está definido. Sistema de apostas não estará disponível.');
}

let client = null;
let db = null;
let isConnecting = false;

/**
 * Conecta ao MongoDB
 */
async function connectToMongoDB() {
  // Se já estiver conectado, retorna a conexão existente
  if (client && db) {
    return { client, db };
  }

  // Se já estiver tentando conectar, aguarda
  if (isConnecting) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return connectToMongoDB();
  }

  if (!BETS_DATABASE_URL) {
    throw new Error('BETS_DATABASE_URL não está definido');
  }

  try {
    isConnecting = true;

    client = new MongoClient(BETS_DATABASE_URL);
    await client.connect();

    // Extrai o nome do database da URL
    const url = new URL(BETS_DATABASE_URL);
    const dbName = url.pathname.substring(1).split('?')[0] || 'bets_db';

    db = client.db(dbName);

    console.log(`[MongoDB Bets] Conectado ao database: ${dbName}`);

    // Criar índices
    await createIndexes(db);

    return { client, db };
  } catch (error) {
    console.error('[MongoDB Bets] Falha ao conectar:', error);
    throw error;
  } finally {
    isConnecting = false;
  }
}

/**
 * Cria índices para melhorar performance
 */
async function createIndexes(db) {
  try {
    const betsCollection = db.collection('bets');
    const logsCollection = db.collection('bet_logs');
    const usersCollection = db.collection('users');

    // Índices para bets
    await betsCollection.createIndex({ userId: 1 });
    await betsCollection.createIndex({ gameId: 1 });
    await betsCollection.createIndex({ marketId: 1 });
    await betsCollection.createIndex({ status: 1 });
    await betsCollection.createIndex({ createdAt: -1 });
    await betsCollection.createIndex({ marketId: 1, userId: 1 });

    // Índices para logs
    await logsCollection.createIndex({ betId: 1 });
    await logsCollection.createIndex({ userId: 1 });
    await logsCollection.createIndex({ action: 1 });
    await logsCollection.createIndex({ createdAt: -1 });
    await logsCollection.createIndex({ marketId: 1 });

    // Índices para users
    await usersCollection.createIndex({ userId: 1 }, { unique: true });

    console.log('[MongoDB Bets] Índices criados com sucesso');
  } catch (error) {
    console.error('[MongoDB Bets] Erro ao criar índices:', error);
  }
}

/**
 * Retorna o database
 */
export async function getBetsDb() {
  const { db } = await connectToMongoDB();
  return db;
}

/**
 * Fecha a conexão com o MongoDB
 */
export async function closeBetsConnection() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log('[MongoDB Bets] Conexão fechada');
  }
}

/**
 * Estrutura de documentos:
 *
 * Collection: users
 * {
 *   _id: ObjectId,
 *   userId: String,  // ID único do usuário (ex: "user-1")
 *   balance: Number,  // Saldo atual
 *   totalBets: Number,  // Total de apostas feitas
 *   totalWon: Number,  // Total ganho
 *   totalLost: Number,  // Total perdido
 *   createdAt: Date,
 *   updatedAt: Date
 * }
 *
 * Collection: bets
 * {
 *   _id: ObjectId,
 *   userId: String,
 *   gameId: String,
 *   gameName: String,
 *   eventType: String,  // 'side', 'corner', 'foul', 'goal', 'atLeastOne'
 *   amount: Number,
 *   selectedSide: String,  // 'A' ou 'B'
 *   marketId: String,  // ID único do mercado (baseado em timestamp de abertura)
 *   marketOpenedAt: Date,  // Quando o mercado foi aberto
 *   marketClosedAt: Date,  // Quando o mercado foi fechado
 *   status: String,  // 'pending', 'won', 'lost', 'refunded', 'cancelled'
 *   odd: Number,  // Odd aplicada na hora da aposta
 *   potentialWin: Number,  // Valor potencial de ganho
 *   result: String?,  // Resultado do evento
 *   payout: Number?,  // Valor pago (se ganhou)
 *   createdAt: Date,
 *   updatedAt: Date,
 *   processedAt: Date?
 * }
 *
 * Collection: bet_logs
 * {
 *   _id: ObjectId,
 *   betId: String,
 *   userId: String,
 *   action: String,  // 'created', 'won', 'lost', 'refunded', 'cancelled', 'error'
 *   message: String,
 *   marketId: String,
 *   metadata: Object,
 *   errorMessage: String?,
 *   createdAt: Date
 * }
 *
 * Collection: markets
 * {
 *   _id: ObjectId,
 *   marketId: String,  // ID único do mercado
 *   status: String,  // 'betting', 'game', 'processing', 'closed'
 *   openedAt: Date,
 *   closedAt: Date?,
 *   gameStartedAt: Date?,
 *   gameEndedAt: Date?,
 *   processedAt: Date?,
 *   totalBets: Number,
 *   totalAmount: Number,
 *   totalPayout: Number?,
 *   results: Object?,  // { sideA: {...}, sideB: {...} }
 *   createdAt: Date,
 *   updatedAt: Date
 * }
 */
