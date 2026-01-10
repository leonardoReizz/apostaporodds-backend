import express from 'express';
import { createServer, METHODS } from 'http';
import { createClient } from 'redis';
import { Server } from 'socket.io';
import { betsService } from './bets-service.js';
import env from './env/index.js';
import EventValidator from './event-validator.js';
import MarketManager from './market-manager.js';
import cors from "cors"
import { decodeJwt } from "./utils/decoded-jwt.js"

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "http://localhost:3000",
    methods: ["GET", "POST"]
  }
});

app.use(cors({
  origin: "*",
}));
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  next();
});

let activeGames = [];
let connectedClients = 0;

// Redis clients globais (reutilizáveis)
let redisClient = null; // Cliente principal para GET/SET
let redisPublisher = null; // Publisher para MarketManager

// Instancia o Event Validator (será inicializado após conectar o Redis)
let eventValidator = null;

// Instancia o Market Manager (será reinicializado após conectar o Redis)
let marketManager = new MarketManager(io);

const ACTIVE_GAMES_CHANNEL = 'prj-nextplay';
const ACTIVE_GAMES_KEY = 'active-games:latest';
const ONLINE_PLAYERS_CHANNEL = 'prj-nextplay';
const ONLINE_PLAYERS_KEY = 'online-players:latest';

// Função para mapear ActiveGame do Redis para o formato do frontend
function mapActiveGameToGame(activeGame) {
  return activeGame
}

// Função para buscar activeGames do Redis
async function fetchActiveGamesFromRedis() {
  const redisClient = createClient({
    socket: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    },
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
  });

  try {
    await redisClient.connect();
    const value = await redisClient.get(`${ACTIVE_GAMES_CHANNEL}:${ACTIVE_GAMES_KEY}`);

    if (value) {
      try {
        const parsed = JSON.parse(value);

        // O valor pode estar no formato { activeGames: [...] } ou { type: "active-games", activeGames: [...] }
        let gamesArray = null;
        if (parsed.type === 'active-games' && Array.isArray(parsed.activeGames)) {
          gamesArray = parsed.activeGames;
        } else if (Array.isArray(parsed.activeGames)) {
          gamesArray = parsed.activeGames;
        } else if (Array.isArray(parsed)) {
          gamesArray = parsed;
        }

        if (gamesArray && Array.isArray(gamesArray)) {
          activeGames = gamesArray;
          console.log(`[Redis] Loaded ${activeGames.length} active games from Redis`);
          broadcastGames();
        } else {
          activeGames = [];
          console.log('[Redis] Invalid format for active games in Redis');
        }
      } catch (parseError) {
        console.error('[Redis] Failed to parse active games value:', parseError);
        activeGames = [];
      }
    } else {
      activeGames = [];
      console.log('[Redis] No active games found in Redis');
    }

    await redisClient.quit();
  } catch (error) {
    console.error('[Redis] Failed to fetch active games:', error);
    activeGames = [];
  }
}

// Função para configurar subscriber do Redis
async function setupRedisSubscriber() {
  const redisSubscriber = createClient({
    socket: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    },
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
  });

  redisSubscriber.on('error', (error) => {
    console.error('[Redis] Subscriber error:', error);
  });

  try {
    await redisSubscriber.connect();
    console.log('[Redis] Subscriber connected');

    // Configurar handler de mensagens antes de subscrever (padrão Redis v5)
    const messageHandler = (message) => {
      try {
        const parsed = JSON.parse(message);

        if (parsed.type === 'active-games' && Array.isArray(parsed.activeGames)) {
          console.log(`[Redis] Received active games update: ${parsed.activeGames.length} games`);
          activeGames = parsed.activeGames.map(mapActiveGameToGame);
          broadcastGames();
        } else if (parsed.type === 'odds' && parsed.odds) {
          console.log('[Redis] Received odds update');
          io.emit('odds-update', {
            type: 'odds',
            odds: parsed.odds,
            timestamp: new Date().toISOString()
          });
        } else if (parsed.type === 'limits' && parsed.limits) {
          console.log('[Redis] Received limits update');
          io.emit('limits-update', {
            type: 'limits',
            limits: parsed.limits,
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        console.error('[Redis] Failed to parse active games message:', error);
      }
    };

    await redisSubscriber.subscribe(ACTIVE_GAMES_CHANNEL, messageHandler);
    console.log(`[Redis] Subscribed to channel: ${ACTIVE_GAMES_CHANNEL}`);
  } catch (error) {
    console.error('[Redis] Failed to initialize subscriber:', error);
  }
}

// Configurar Redis Client global (para GET/SET)
async function setupRedisClient() {
  redisClient = createClient({
    socket: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    },
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
  });

  redisClient.on('error', (error) => {
    console.error('[Redis Client] Erro na conexão:', error);
  });

  try {
    await redisClient.connect();
    console.log('[Redis Client] ✅ Conectado (conexão persistente)');
  } catch (error) {
    console.error('[Redis Client] Erro ao conectar:', error);
  }
}

// Configurar Redis Publisher para o MarketManager
async function setupRedisPublisher() {
  redisPublisher = createClient({
    socket: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    },
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
  });

  redisPublisher.on('error', (error) => {
    console.error('[Redis] Publisher error:', error);
  });

  try {
    await redisPublisher.connect();
    console.log('[Redis] Publisher connected');

    // Inicializa o EventValidator
    eventValidator = new EventValidator(io);
    await eventValidator.initialize();
    console.log('[EventValidator] Inicializado');

    // Reinicializa o MarketManager com o Redis Publisher, BetsService e EventValidator
    marketManager = new MarketManager(
      io,
      redisPublisher,
      betsService,
      eventValidator,
      () => activeGames // Getter para jogos ativos
    );
    console.log('[MarketManager] Inicializado com Redis Publisher, BetsService e EventValidator');
  } catch (error) {
    console.error('[Redis] Failed to initialize publisher:', error);
  }
}

// Inicializar: buscar jogos do Redis e configurar subscriber
async function initializeRedis() {
  await setupRedisClient(); // Inicializa cliente global primeiro
  await setupRedisPublisher();
  await fetchActiveGamesFromRedis();
  await setupRedisSubscriber();
  // Inicializar contador de jogadores online no Redis
  await publishOnlinePlayers();
}

initializeRedis();

function broadcastGames() {
  const payload = {
    type: 'active-games',
    activeGames: activeGames,
    timestamp: new Date().toISOString()
  };
  console.log(`[WebSocket] Broadcasting ${activeGames.length} active games to ${connectedClients} clients`);
  io.emit('active-games-update', payload);
}

// Função para publicar número de jogadores online no Redis
async function publishOnlinePlayers() {
  if (!redisClient || !redisClient.isOpen) {
    console.error('[Redis] Cliente Redis não está conectado');
    return;
  }

  try {
    const message = JSON.stringify({
      type: 'online-players',
      count: connectedClients,
      timestamp: new Date().toISOString(),
    });

    console.log(`[Redis] Publicando online players: ${connectedClients}`);

    await Promise.all([
      redisClient.set(`${ONLINE_PLAYERS_CHANNEL}:${ONLINE_PLAYERS_KEY}`, message),
      redisClient.publish(ONLINE_PLAYERS_CHANNEL, message)
    ]);
  } catch (error) {
    console.error('[Redis] Failed to publish online players:', error);
  }
}

// Rota para buscar jogos ativos do Redis (GET inicial)
app.get('/api/games/active', async (req, res) => {
  try {
    const redisClient = createClient({
      socket: {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
      },
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
    });

    await redisClient.connect();
    const value = await redisClient.get(`${ACTIVE_GAMES_CHANNEL}:${ACTIVE_GAMES_KEY}`);

    let gamesArray = [];
    if (value) {
      try {
        const parsed = JSON.parse(value);

        if (parsed.type === 'active-games' && Array.isArray(parsed.activeGames)) {
          gamesArray = parsed.activeGames;
        } else if (Array.isArray(parsed.activeGames)) {
          gamesArray = parsed.activeGames;
        }
      } catch (parseError) {
        console.error('[API] Failed to parse active games:', parseError);
      }
    }

    await redisClient.quit();

    res.json({ activeGames: gamesArray });
  } catch (error) {
    console.error('[API] Failed to fetch active games:', error);
    res.status(500).json({ error: 'Failed to fetch active games' });
  }
});

// Os jogos são buscados diretamente do Redis
app.get('/api/games', (req, res) => {
  return res.json(activeGames);
});


// Inicia o ciclo automático
// TODO: VALIDACAO DO ADMIN BACKEND
app.post('/api/market/start', async (req, res) => {
  if (activeGames.length === 0) {
    return res.status(400).json({
      error: 'É necessário ter pelo menos um jogo para iniciar o ciclo automático'
    });
  }

  const success = await marketManager.startAutomaticCycle();

  if (!success) {
    return res.status(400).json({
      error: 'Ciclo automático já está rodando'
    });
  }

  res.json({
    success: true,
    message: 'Ciclo automático iniciado. O mercado abrirá automaticamente.',
    gamesCount: activeGames.length,
    status: marketManager.getStatus()
  });
});

// Para o ciclo automático
app.post('/api/market/stop', (req, res) => {
  const success = marketManager.stopAutomaticCycle();

  res.json({
    success: true,
    message: 'Ciclo automático parado',
    status: marketManager.getStatus()
  });
});

app.get('/api/market/status', (req, res) => {
  const status = marketManager.getStatus();
  res.json({
    ...status,
    gamesCount: activeGames.length
  });
});

// Rota para buscar número de jogadores online
app.get('/api/online-players', (req, res) => {
  res.json({
    count: connectedClients
  });
});

// Rota para buscar limites configurados
app.get('/api/limits', async (req, res) => {
  try {
    const redisClient = createClient({
      socket: {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
      },
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
    });

    await redisClient.connect();
    const value = await redisClient.get('prj-nextplay:limits:latest');

    let limits = null;
    if (value) {
      try {
        const parsed = JSON.parse(value);
        if (parsed.type === 'limits' && parsed.limits) {
          limits = parsed.limits;
        }
      } catch (parseError) {
        console.error('[API] Failed to parse limits:', parseError);
      }
    }

    await redisClient.quit();

    // Retorna limites padrão se não houver configurados (valores em centavos)
    if (!limits) {
      limits = {
        minimumBet: 200,      // 200 centavos = R$ 2,00
        maximumBet: 10000,    // 10000 centavos = R$ 100,00
        refund: 95,
        bettingTime: 10,
        playTime: 60,
        waitingTime: 10
      };
    }

    res.json({ limits });
  } catch (error) {
    console.error('[API] Failed to fetch limits:', error);
    res.status(500).json({ error: 'Failed to fetch limits' });
  }
});

// Rota para buscar odds configuradas
app.get('/api/odds', async (req, res) => {
  try {
    const redisClient = createClient({
      socket: {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
      },
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
    });

    await redisClient.connect();
    const value = await redisClient.get('prj-nextplay:odds:latest');

    let odds = null;
    if (value) {
      try {
        const parsed = JSON.parse(value);
        if (parsed.type === 'odds' && parsed.odds) {
          odds = parsed.odds;
        }
      } catch (parseError) {
        console.error('[API] Failed to parse odds:', parseError);
      }
    }

    await redisClient.quit();

    // Retorna odds padrão se não houver configuradas
    if (!odds) {
      odds = {
        side: 1.50,
        corner: 1.50,
        foul: 1.50,
        goal: 1.50,
        atLeastOne: 1.50
      };
    }

    res.json({ odds });
  } catch (error) {
    console.error('[API] Failed to fetch odds:', error);
    res.status(500).json({ error: 'Failed to fetch odds' });
  }
});

// Rota para realizar apostas
app.post('/api/bets/place', async (req, res) => {
  const {
    gameId, 
    eventType, 
    amount, 
    selectedSide, 
    biabCustomer, 
    accountId, 
    sportId,
    sportName,
    competitionId,
    competitionName,
    eventId, 
    eventName,
    eventDate,
  } = req.body;
    
  // Validação de campos obrigatórios
  if (
    !gameId || 
    !eventType || 
    !amount || 
    !accountId ||
    !biabCustomer ||
    !selectedSide || 
    amount <= 0 || 
    !sportId || 
    !sportName || 
    !competitionId || 
    !competitionName || 
    !eventId || 
    !eventName || 
    !eventDate
  ) {
    return res.status(400).json({
      error: 'Campos obrigatórios faltando',
      required: ['gameId', 'eventType', 'amount', 'selectedSide']
    });
  }

  let userId = null
  let loginId = null

  try {
    const decoded = decodeJwt(biabCustomer);
    if (decoded) {
      userId = decoded.userId
      loginId = decoded.loginId
    }
  } catch(error) {
    console.log("ERROR: decoded token:", error)
    return res.status(400).json({
      error: 'Error ao fazer decoded do token'
    });
  }

  if(userId === null) {
    return res.status(400).json({
      error: 'Error ao fazer decoded do token'
    });
  }

  // Validação: mercado deve estar aberto
  if (!marketManager.canPlaceBet()) {
    return res.status(403).json({
      marketStatus: marketManager.getStatus()
    });
  }

  // Validação: deve haver um mercado aberto no BetsService
  if (!betsService.hasOpenMarket()) {
    return res.status(403).json({
      error: 'Nenhum mercado de apostas aberto no momento.',
      marketStatus: marketManager.getStatus()
    });
  }

  // Validação: jogo deve estar ativo
  const game = activeGames.find(g => g.id === gameId);
  if (!game) {
    return res.status(404).json({
      error: 'Jogo não encontrado ou não está ativo'
    });
  }
  
  let odd = null;
  try {
    const oddsValue = await redisClient.get('prj-nextplay:odds:latest');

    if (oddsValue) {
      const parsed = JSON.parse(oddsValue);
      if (parsed.type === 'odds' && parsed.odds && parsed.odds[eventType]) {
        odd = parsed.odds[eventType];
      }
    }
  } catch (error) {
    console.error('[Bet] Erro ao buscar odds:', error);
    return res.status(500).json({
      error: 'Erro ao buscar odds'
    });
  }

  if(odd === null) {
    return res.status(404).json({
      error: 'Jogo não encontrado ou não está ativo'
    });
  }

  // Realiza a aposta usando o BetsService
  const result = await betsService.placeBet({
    userId,
    gameId,
    accountId,
    gameName: game.name || game.id,
    eventType,
    amount,
    selectedSide,
    odd,
    loginId,
    biabCustomer,
    sportId,
    sportName,
    competitionId,
    competitionName,
    eventId,
    eventName,
    eventDate,
  });

  if (!result.success) {
    return res.status(400).json({
      error: result.error || 'Erro ao realizar aposta'
    });
  }

  res.json({
    success: true,
    message: 'Aposta realizada com sucesso',
    bet: result.bet,
    betId: result.betId,
    marketId: result.marketId,
    newBalance: result.newBalance
  });
});

// Rota para buscar apostas de um usuário
app.get('/api/bets/user/:accountId', async (req, res) => {
  const { accountId } = req.params;
  const limit = parseInt(req.query.limit) || 50;

  try {
    const result = await betsService.getBetsByUser(accountId, limit);

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Erro ao buscar apostas'
      });
    }

    res.json({
      success: true,
      bets: result.bets,
      count: result.bets.length
    });
  } catch (error) {
    console.error('[API] Erro ao buscar apostas do usuário:', error);
    res.status(500).json({
      error: 'Erro ao buscar apostas'
    });
  }
});

// Rota para buscar estatísticas de um usuário
app.get('/api/users/:accountId', async (req, res) => {
  const { accountId } = req.params;

  try {
    const { getBetsDb } = await import('./mongodb.js');
    const db = await getBetsDb();
    const betsCollection = db.collection('bets');

    // Busca todas as apostas do usuário
    const userBets = await betsCollection
      .find({ accountId })
      .toArray();

    // Calcula estatísticas
    const totalBets = userBets.length;

    let totalWon = 0;   // Total ganho (lucro líquido)
    let totalLost = 0;  // Total perdido

    userBets.forEach(bet => {
      // O valor apostado é o valor absoluto de transaction.amount (que é negativo)
      const stakeAmount = Math.abs(bet.transaction?.amount || 0);

      // Verifica o status da aposta
      if (bet.status === 'BETTED' && bet.profit && bet.profit > 0) {
        // Aposta GANHA: profit já vem calculado da API (stake * odd - stake)
        // Ex: apostou R$ 1, odd 2.0 -> profit = 2 - 1 = R$ 1 de lucro
        totalWon += bet.profit;
      }
      else if (bet.status === 'void' && bet.refund !== undefined) {
        // Aposta ANULADA com reembolso parcial
        // Ex: apostou R$ 1, refund = 0.9 -> devolveu R$ 0.90, perdeu R$ 0.10
        const refundedAmount = bet.refund;
        const lossAmount = stakeAmount - refundedAmount;
        totalLost += lossAmount;
      }
      else if (bet.status === 'BETTED' && (!bet.profit || bet.profit <= 0)) {
        // Aposta PERDIDA: perde todo o valor apostado
        totalLost += stakeAmount;
      }
      else if (bet.status === 'void' && !bet.refund) {
        // Aposta ANULADA sem reembolso: perde todo o valor
        totalLost += stakeAmount;
      }
      // Status 'pending', 'confirmed', 'failed', 'error' não entram no cálculo
    });

    // Calcula lucro/prejuízo total
    const profit = totalWon - totalLost;

    // Retorna as estatísticas em centavos (multiplicar por 100 para converter reais -> centavos)
    res.json({
      success: true,
      user: {
        accountId,
        totalBets,
        totalWon: Math.round(totalWon * 100),      // Converte para centavos
        totalLost: Math.round(totalLost * 100),    // Converte para centavos
        profit: Math.round(profit * 100)           // Converte para centavos
      }
    });
  } catch (error) {
    console.error('[API] Erro ao buscar estatísticas do usuário:', error);
    res.status(500).json({
      error: 'Erro ao buscar estatísticas do usuário',
      message: error.message
    });
  }
});

// Rota para buscar apostas de um mercado específico
app.get('/api/bets/market/:marketId', async (req, res) => {
  const { marketId } = req.params;

  try {
    const result = await betsService.getBetsByMarket(marketId);

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Erro ao buscar apostas do mercado'
      });
    }

    res.json({
      success: true,
      marketId,
      bets: result.bets,
      count: result.bets.length
    });
  } catch (error) {
    console.error('[API] Erro ao buscar apostas do mercado:', error);
    res.status(500).json({
      error: 'Erro ao buscar apostas do mercado'
    });
  }
});

// Rota para buscar informações de um mercado
app.get('/api/markets/:marketId', async (req, res) => {
  const { marketId } = req.params;

  try {
    const result = await betsService.getMarket(marketId);

    if (!result.success) {
      return res.status(404).json({
        error: result.error || 'Mercado não encontrado'
      });
    }

    res.json({
      success: true,
      market: result.market
    });
  } catch (error) {
    console.error('[API] Erro ao buscar mercado:', error);
    res.status(500).json({
      error: 'Erro ao buscar mercado'
    });
  }
});

// Rota para buscar o mercado atual
app.get('/api/markets/current', async (req, res) => {
  try {
    const currentMarketId = betsService.getCurrentMarketId();

    if (!currentMarketId) {
      return res.json({
        success: true,
        currentMarket: null,
        message: 'Nenhum mercado aberto no momento'
      });
    }

    const result = await betsService.getMarket(currentMarketId);

    if (!result.success) {
      return res.status(404).json({
        error: result.error || 'Mercado não encontrado'
      });
    }

    res.json({
      success: true,
      currentMarket: result.market
    });
  } catch (error) {
    console.error('[API] Erro ao buscar mercado atual:', error);
    res.status(500).json({
      error: 'Erro ao buscar mercado atual'
    });
  }
});

// Rota para buscar logs de uma aposta
app.get('/api/bets/:betId/logs', async (req, res) => {
  const { betId } = req.params;

  try {
    const result = await betsService.getBetLogs(betId);

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Erro ao buscar logs da aposta'
      });
    }

    res.json({
      success: true,
      betId,
      logs: result.logs,
      count: result.logs.length
    });
  } catch (error) {
    console.error('[API] Erro ao buscar logs da aposta:', error);
    res.status(500).json({
      error: 'Erro ao buscar logs da aposta'
    });
  }
});

// Rota para buscar eventos de um mercado
app.get('/api/markets/:marketId/events', async (req, res) => {
  const { marketId } = req.params;

  try {
    let events = [];

    // Primeiro tenta buscar da memória (EventValidator)
    if (eventValidator) {
      events = eventValidator.getMarketEvents(marketId);
    }

    // Se não encontrou na memória, busca do banco de dados
    if (events.length === 0) {
      const marketResult = await betsService.getMarket(marketId);

      if (marketResult.success && marketResult.market && marketResult.market.results) {
        const results = marketResult.market.results;

        // Reconstruir array de eventos a partir dos results salvos
        if (results.eventsBySide) {
          if (results.eventsBySide.A && results.eventsBySide.A.events) {
            events.push(...results.eventsBySide.A.events.map(e => ({
              ...e,
              gameId: results.eventsBySide.A.gameId,
              side: 'A'
            })));
          }

          if (results.eventsBySide.B && results.eventsBySide.B.events) {
            events.push(...results.eventsBySide.B.events.map(e => ({
              ...e,
              gameId: results.eventsBySide.B.gameId,
              side: 'B'
            })));
          }
        }

        // Ordena por timestamp
        events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      }
    }

    res.json({
      success: true,
      marketId,
      events,
      count: events.length
    });
  } catch (error) {
    console.error('[API] Erro ao buscar eventos do mercado:', error);
    res.status(500).json({
      error: 'Erro ao buscar eventos do mercado'
    });
  }
});

io.on('connection', async (socket) => {
  console.log(`[WebSocket] Cliente conectado: ${socket.id} (Total: ${connectedClients + 1})`);
  connectedClients++;
  publishOnlinePlayers();

  // Envia jogos ativos iniciais para o novo cliente
  socket.emit('active-games-update', {
    type: 'active-games',
    activeGames: activeGames,
    timestamp: new Date().toISOString()
  });

  // Envia status do mercado atual
  socket.emit('market-status', marketManager.getStatus());

  // Envia odds iniciais
  try {
    const oddsValue = await redisClient.get('prj-nextplay:odds:latest');
    let odds = null;
    if (oddsValue) {
      const parsed = JSON.parse(oddsValue);
      if (parsed.type === 'odds' && parsed.odds) {
        odds = parsed.odds;
      }
    }
    if (!odds) {
      odds = {
        side: 1.50,
        corner: 1.50,
        foul: 1.50,
        goal: 1.50,
        atLeastOne: 1.50
      };
    }
    socket.emit('odds-update', {
      type: 'odds',
      odds: odds,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[WebSocket] Erro ao enviar odds iniciais:', error);
  }

  // Envia limits iniciais
  try {
    const limitsValue = await redisClient.get('prj-nextplay:limits:latest');
    let limits = null;
    if (limitsValue) {
      const parsed = JSON.parse(limitsValue);
      if (parsed.type === 'limits' && parsed.limits) {
        limits = parsed.limits;
      }
    }
    if (!limits) {
      limits = {
        minimumBet: 200,
        maximumBet: 10000,
        refund: 95,
        bettingTime: 10,
        playTime: 60,
        waitingTime: 10
      };
    }
    socket.emit('limits-update', {
      type: 'limits',
      limits: limits,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[WebSocket] Erro ao enviar limits iniciais:', error);
  }

  // Listener para solicitar jogos ativos manualmente
  socket.on('request-active-games', () => {
    console.log(`[WebSocket] Cliente ${socket.id} solicitou jogos ativos`);
    socket.emit('active-games-update', {
      type: 'active-games',
      activeGames: activeGames,
      timestamp: new Date().toISOString()
    });
  });

  // Listener para solicitar odds manualmente
  socket.on('request-odds', async () => {
    console.log(`[WebSocket] Cliente ${socket.id} solicitou odds`);
    try {
      const oddsValue = await redisClient.get('prj-nextplay:odds:latest');
      let odds = null;
      if (oddsValue) {
        const parsed = JSON.parse(oddsValue);
        if (parsed.type === 'odds' && parsed.odds) {
          odds = parsed.odds;
        }
      }
      if (!odds) {
        odds = {
          side: 1.50,
          corner: 1.50,
          foul: 1.50,
          goal: 1.50,
          atLeastOne: 1.50
        };
      }
      socket.emit('odds-update', {
        type: 'odds',
        odds: odds,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[WebSocket] Erro ao enviar odds:', error);
    }
  });

  // Listener para solicitar limits manualmente
  socket.on('request-limits', async () => {
    console.log(`[WebSocket] Cliente ${socket.id} solicitou limits`);
    try {
      const limitsValue = await redisClient.get('prj-nextplay:limits:latest');
      let limits = null;
      if (limitsValue) {
        const parsed = JSON.parse(limitsValue);
        if (parsed.type === 'limits' && parsed.limits) {
          limits = parsed.limits;
        }
      }
      if (!limits) {
        limits = {
          minimumBet: 200,
          maximumBet: 10000,
          refund: 95,
          bettingTime: 10,
          playTime: 60,
          waitingTime: 10
        };
      }
      socket.emit('limits-update', {
        type: 'limits',
        limits: limits,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('[WebSocket] Erro ao enviar limits:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log(`[WebSocket] Cliente desconectado: ${socket.id} (Total: ${connectedClients - 1})`);
    connectedClients = Math.max(0, connectedClients - 1);
    publishOnlinePlayers();
  });
});

const PORT = env.PORT;
httpServer.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`WebSocket disponível em ws://localhost:${PORT}`);
});
