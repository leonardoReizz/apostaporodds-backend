import express from 'express';
import { createServer, METHODS } from 'http';
import { createClient } from 'redis';
import { Server } from 'socket.io';
import { betsService } from './bets-service.js';
import env from './env/index.js';
import EventValidator from './event-validator.js';
import MarketManager from './market-manager.js';
import { usersService } from './users-service.js';
import cors from "cors"

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

// Redis Publisher para o MarketManager
let redisPublisher = null;

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
        }
      } catch (error) {
        console.error('[Redis] Failed to parse active games message:', error);
      }
    };

    // Registrar o handler usando o método correto do Redis v5

    // Subscrever ao canal de active games
    await redisSubscriber.subscribe(ACTIVE_GAMES_CHANNEL, messageHandler);
    console.log(`[Redis] Subscribed to channel: ${ACTIVE_GAMES_CHANNEL}`);
  } catch (error) {
    console.error('[Redis] Failed to initialize subscriber:', error);
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
    eventValidator = new EventValidator(betsService, usersService, io);
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
  await setupRedisPublisher();
  await fetchActiveGamesFromRedis();
  await setupRedisSubscriber();
  // Inicializar contador de jogadores online no Redis
  await publishOnlinePlayers();
}

initializeRedis();

function broadcastGames() {
  io.emit('games-update', activeGames);
}

// Função para publicar número de jogadores online no Redis
async function publishOnlinePlayers() {
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

    const message = JSON.stringify({
      type: 'online-players',
      count: connectedClients,
      emittedAt: new Date().toISOString(),
    });

    await redisClient.set(`${ONLINE_PLAYERS_CHANNEL}:${ONLINE_PLAYERS_KEY}`, message);
    await redisClient.publish(ONLINE_PLAYERS_CHANNEL, message);

    await redisClient.quit();
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

// Rota SSE para stream de jogos ativos
app.get('/api/games/active/stream', async (req, res) => {
  // Configurar headers para SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Função para enviar dados via SSE
  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Buscar jogos iniciais do Redis.
  const fetchAndSendInitialGames = async () => {
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
          console.error('[SSE] Failed to parse active games:', parseError);
        }
      }

      await redisClient.quit();

      // Enviar jogos iniciais

      sendSSE({
        type: 'active-games',
        activeGames: gamesArray
      });
    } catch (error) {
      console.error('[SSE] Failed to fetch initial games:', error);
      sendSSE({
        type: 'active-games',
        activeGames: []
      });
    }
  };

  // Enviar heartbeat periódico
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  // Configurar subscriber do Redis para esta conexão
  const redisSubscriber = createClient({
    socket: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    },
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
  });

  redisSubscriber.on('error', (error) => {
    console.error('[SSE] Redis subscriber error:', error);
  });

  try {
    await redisSubscriber.connect();

    // Handler para mensagens do Redis (padrão Redis v5)
    const messageHandler = (message) => {
      try {
        const parsed = JSON.parse(message);

        if (parsed.type === 'active-games' && Array.isArray(parsed.activeGames)) {
          sendSSE({
            type: 'active-games',
            activeGames: parsed.activeGames
          });
        }
      } catch (error) {
        console.error('[SSE] Failed to parse Redis message:', error);
      }
    };

    // Subscrever ao canal
    await redisSubscriber.subscribe(ACTIVE_GAMES_CHANNEL, messageHandler);

    // Buscar e enviar jogos iniciais
    await fetchAndSendInitialGames();

    // Limpar quando a conexão for fechada
    req.on('close', async () => {
      clearInterval(heartbeatInterval);
      try {
        await redisSubscriber.unsubscribe(ACTIVE_GAMES_CHANNEL);
        await redisSubscriber.quit();
      } catch (error) {
        console.error('[SSE] Error cleaning up:', error);
      }
      res.end();
    });
  } catch (error) {
    console.error('[SSE] Failed to setup Redis subscriber:', error);
    clearInterval(heartbeatInterval);
    res.end();
  }
});

// Endpoints removidos - os jogos agora são gerenciados pelo admin via Next.js
// Os jogos são buscados diretamente do Redis

app.get('/api/games', (req, res) => {
  res.json(activeGames);
});


// Inicia o ciclo automático
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

// Rota SSE para stream de odds
app.get('/api/odds/stream', async (req, res) => {
  // Configurar headers para SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Função para enviar dados via SSE
  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Buscar odds iniciais do Redis
  const fetchAndSendInitialOdds = async () => {
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
          console.error('[SSE Odds] Failed to parse odds:', parseError);
        }
      }

      // Odds padrão se não houver configuradas
      if (!odds) {
        odds = {
          side: 1.50,
          corner: 1.50,
          foul: 1.50,
          goal: 1.50,
          atLeastOne: 1.50
        };
      }

      await redisClient.quit();

      // Enviar odds iniciais
      sendSSE({
        type: 'odds',
        odds: odds
      });
    } catch (error) {
      console.error('[SSE Odds] Failed to fetch initial odds:', error);
      sendSSE({
        type: 'odds',
        odds: {
          side: 1.50,
          corner: 1.50,
          foul: 1.50,
          goal: 1.50,
          atLeastOne: 1.50
        }
      });
    }
  };

  // Enviar heartbeat periódico
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  // Configurar subscriber do Redis para esta conexão
  const redisSubscriber = createClient({
    socket: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    },
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
  });

  redisSubscriber.on('error', (error) => {
    console.error('[SSE Odds] Redis subscriber error:', error);
  });

  try {
    await redisSubscriber.connect();

    // Handler para mensagens do Redis
    const messageHandler = (message) => {
      try {
        const parsed = JSON.parse(message);

        if (parsed.type === 'odds' && parsed.odds) {
          console.log('[SSE Odds] Odds update received:', parsed.odds);
          sendSSE({
            type: 'odds',
            odds: parsed.odds
          });
        }
      } catch (error) {
        console.error('[SSE Odds] Failed to parse Redis message:', error);
      }
    };

    // Subscrever ao canal de odds (mesmo canal que active games)
    await redisSubscriber.subscribe(ACTIVE_GAMES_CHANNEL, messageHandler);
    console.log('[SSE Odds] Client connected to odds stream');

    // Buscar e enviar odds iniciais
    await fetchAndSendInitialOdds();

    // Limpar quando a conexão for fechada
    req.on('close', async () => {
      console.log('[SSE Odds] Client disconnected');
      clearInterval(heartbeatInterval);
      try {
        await redisSubscriber.unsubscribe(ACTIVE_GAMES_CHANNEL);
        await redisSubscriber.quit();
      } catch (error) {
        console.error('[SSE Odds] Error cleaning up:', error);
      }
      res.end();
    });
  } catch (error) {
    console.error('[SSE Odds] Failed to setup Redis subscriber:', error);
    clearInterval(heartbeatInterval);
    res.end();
  }
});

// Rota SSE para stream de limits
app.get('/api/limits/stream', async (req, res) => {
  // Configurar headers para SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Função para enviar dados via SSE
  const sendSSE = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Buscar limits iniciais do Redis
  const fetchAndSendInitialLimits = async () => {
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
          console.error('[SSE Limits] Failed to parse limits:', parseError);
        }
      }

      // Limits padrão se não houver configurados (valores em centavos)
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

      await redisClient.quit();

      // Enviar limits iniciais
      sendSSE({
        type: 'limits',
        limits: limits
      });
    } catch (error) {
      console.error('[SSE Limits] Failed to fetch initial limits:', error);
      sendSSE({
        type: 'limits',
        limits: {
          minimumBet: 200,      // 200 centavos = R$ 2,00
          maximumBet: 10000,    // 10000 centavos = R$ 100,00
          refund: 95,
          bettingTime: 10,
          playTime: 60,
          waitingTime: 10
        }
      });
    }
  };

  // Enviar heartbeat periódico
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 25000);

  // Configurar subscriber do Redis para esta conexão
  const redisSubscriber = createClient({
    socket: {
      host: env.REDIS_HOST,
      port: env.REDIS_PORT,
    },
    username: env.REDIS_USERNAME,
    password: env.REDIS_PASSWORD,
  });

  redisSubscriber.on('error', (error) => {
    console.error('[SSE Limits] Redis subscriber error:', error);
  });

  try {
    await redisSubscriber.connect();

    // Handler para mensagens do Redis
    const messageHandler = (message) => {
      try {
        const parsed = JSON.parse(message);

        if (parsed.type === 'limits' && parsed.limits) {
          console.log('[SSE Limits] Limits update received:', parsed.limits);
          sendSSE({
            type: 'limits',
            limits: parsed.limits
          });
        }
      } catch (error) {
        console.error('[SSE Limits] Failed to parse Redis message:', error);
      }
    };

    // Subscrever ao canal de limits (mesmo canal que active games)
    await redisSubscriber.subscribe(ACTIVE_GAMES_CHANNEL, messageHandler);
    console.log('[SSE Limits] Client connected to limits stream');

    // Buscar e enviar limits iniciais
    await fetchAndSendInitialLimits();

    // Limpar quando a conexão for fechada
    req.on('close', async () => {
      console.log('[SSE Limits] Client disconnected');
      clearInterval(heartbeatInterval);
      try {
        await redisSubscriber.unsubscribe(ACTIVE_GAMES_CHANNEL);
        await redisSubscriber.quit();
      } catch (error) {
        console.error('[SSE Limits] Error cleaning up:', error);
      }
      res.end();
    });
  } catch (error) {
    console.error('[SSE Limits] Failed to setup Redis subscriber:', error);
    clearInterval(heartbeatInterval);
    res.end();
  }
});

// Rota para realizar apostas
app.post('/api/bets/place', async (req, res) => {
  const { userId, gameId, eventType, amount, selectedSide } = req.body;

  // Validação de campos obrigatórios
  if (!userId || !gameId || !eventType || !amount || !selectedSide) {
    return res.status(400).json({
      error: 'Campos obrigatórios faltando',
      required: ['userId', 'gameId', 'eventType', 'amount', 'selectedSide']
    });
  }

  // Validação: mercado deve estar aberto
  if (!marketManager.canPlaceBet()) {
    return res.status(403).json({
      error: 'Mercado fechado. Não é possível realizar apostas no momento.',
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

  // TODO: REMOVER ISSO DAQUI DEVERA FICAR NA API DO GUI
  // Validação: valor mínimo
  if (amount <= 0) {
    return res.status(400).json({
      error: 'Valor da aposta deve ser maior que zero'
    });
  }

  // Busca usuário
  const userResult = await usersService.getUser(userId);
  if (!userResult.success) {
    return res.status(500).json({
      error: 'Erro ao buscar dados do usuário'
    });
  }


  // TODO REMOVER ISSO, FICARA NA API DO GUI
  // Validação: saldo suficiente
  if (userResult.user.balance < amount) {
    return res.status(400).json({
      error: 'Saldo insuficiente',
      currentBalance: userResult.user.balance,
      required: amount
    });
  }

  // Buscar odds do Redis
  let odd = 1.50; // Odd padrão
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
    const oddsValue = await redisClient.get('prj-nextplay:odds:latest');

    if (oddsValue) {
      const parsed = JSON.parse(oddsValue);
      if (parsed.type === 'odds' && parsed.odds && parsed.odds[eventType]) {
        odd = parsed.odds[eventType];
      }
    }

    await redisClient.quit();
  } catch (error) {
    console.error('[Bet] Erro ao buscar odds:', error);
    // Continua com a odd padrão
  }

  // Realiza a aposta usando o BetsService
  const result = await betsService.placeBet({
    userId,
    gameId,
    gameName: game.name || game.id,
    eventType,
    amount,
    selectedSide,
    odd
  });

  if (!result.success) {
    return res.status(400).json({
      error: result.error || 'Erro ao realizar aposta'
    });
  }

  // Deduz o valor do saldo do usuário
  const deductResult = await usersService.deductBalance(userId, amount);
  if (!deductResult.success) {
    // Se falhar ao deduzir, tentar reverter a aposta (implementar rollback se necessário)
    console.error('[Bet] Erro ao deduzir saldo:', deductResult.error);
    return res.status(500).json({
      error: 'Erro ao processar pagamento da aposta'
    });
  }

  console.log('[Bet] Nova aposta criada:', {
    betId: result.betId,
    marketId: result.marketId,
    userId,
    gameId,
    eventType,
    amount,
    selectedSide,
    odd,
    potentialWin: amount * odd,
    newBalance: deductResult.newBalance
  });

  // Criar registro no banco para teste do finalizar-apostas
  try {
    const { getBetsDb } = await import('./mongodb.js');
    const { ObjectId } = await import('mongodb');
    const db = await getBetsDb();
    const betsCollection = db.collection('bets');

    const betDoc = {
      _id: new ObjectId(),
      betId: result.betId,
      userId,
      gameId,
      gameName: game.name || game.id,
      marketId: result.marketId,
      eventType,
      selectedSide,
      amount,
      odd,
      potentialWin: Math.floor(amount * odd),
      status: 'pending',
      payout: null,
      refund: null,
      resultReason: null,
      eventsCount: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      processedAt: null
    };

    await betsCollection.insertOne(betDoc);
  } catch (error) {
    console.error('[Bet] Erro ao inserir no banco:', error);
  }

  res.json({
    success: true,
    message: 'Aposta realizada com sucesso',
    bet: result.bet,
    betId: result.betId,
    marketId: result.marketId,
    newBalance: deductResult.newBalance
  });
});

// Rota para buscar apostas de um usuário
app.get('/api/bets/user/:userId', async (req, res) => {
  const { userId } = req.params;
  const limit = parseInt(req.query.limit) || 50;

  try {
    const result = await betsService.getBetsByUser(userId, limit);

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

// Rota para buscar estatísticas gerais
app.get('/api/bets/stats', async (req, res) => {
  try {
    const result = await betsService.getStats();

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Erro ao buscar estatísticas'
      });
    }

    res.json({
      success: true,
      stats: result.stats
    });
  } catch (error) {
    console.error('[API] Erro ao buscar estatísticas:', error);
    res.status(500).json({
      error: 'Erro ao buscar estatísticas'
    });
  }
});

// Rota para buscar estatísticas do dia
app.get('/api/bets/stats/daily', async (req, res) => {
  try {
    const result = await betsService.getDailyStats();

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Erro ao buscar estatísticas do dia'
      });
    }

    res.json({
      success: true,
      stats: result.stats
    });
  } catch (error) {
    console.error('[API] Erro ao buscar estatísticas do dia:', error);
    res.status(500).json({
      error: 'Erro ao buscar estatísticas do dia'
    });
  }
});

// Rota para buscar eventos de um mercado
app.get('/api/markets/:marketId/events', async (req, res) => {
  const { marketId } = req.params;

  try {
    if (!eventValidator) {
      return res.status(503).json({
        error: 'EventValidator não inicializado'
      });
    }

    const events = eventValidator.getMarketEvents(marketId);

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

// ==================== ENDPOINTS DE USUÁRIOS ====================

// Rota para buscar informações de um usuário
app.get('/api/users/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await usersService.getUser(userId);

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Erro ao buscar usuário'
      });
    }

    res.json({
      success: true,
      user: result.user
    });
  } catch (error) {
    console.error('[API] Erro ao buscar usuário:', error);
    res.status(500).json({
      error: 'Erro ao buscar usuário'
    });
  }
});

// Rota para adicionar saldo manualmente (admin)
app.post('/api/users/:userId/add-balance', async (req, res) => {
  const { userId } = req.params;
  const { amount, reason } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({
      error: 'Valor deve ser maior que zero'
    });
  }

  try {
    const result = await usersService.addBalanceManual(userId, amount, reason);

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Erro ao adicionar saldo'
      });
    }

    res.json({
      success: true,
      message: result.message,
      user: result.user,
      newBalance: result.newBalance
    });
  } catch (error) {
    console.error('[API] Erro ao adicionar saldo:', error);
    res.status(500).json({
      error: 'Erro ao adicionar saldo'
    });
  }
});

// Rota para resetar saldo de um usuário
app.post('/api/users/:userId/reset-balance', async (req, res) => {
  const { userId } = req.params;
  const { newBalance } = req.body;

  const balanceToSet = newBalance !== undefined ? newBalance : 1000;

  try {
    const result = await usersService.resetBalance(userId, balanceToSet);

    if (!result.success) {
      return res.status(404).json({
        error: result.error || 'Usuário não encontrado'
      });
    }

    res.json({
      success: true,
      message: `Saldo resetado para R$ ${balanceToSet}`,
      user: result.user,
      newBalance: result.newBalance
    });
  } catch (error) {
    console.error('[API] Erro ao resetar saldo:', error);
    res.status(500).json({
      error: 'Erro ao resetar saldo'
    });
  }
});

// Rota para listar todos os usuários
app.get('/api/users', async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;

  try {
    const result = await usersService.getAllUsers(limit);

    if (!result.success) {
      return res.status(500).json({
        error: result.error || 'Erro ao listar usuários'
      });
    }

    res.json({
      success: true,
      users: result.users,
      count: result.count
    });
  } catch (error) {
    console.error('[API] Erro ao listar usuários:', error);
    res.status(500).json({
      error: 'Erro ao listar usuários'
    });
  }
});

io.on('connection', (socket) => {
  console.log('Cliente conectado:', socket.id);
  connectedClients++;
  publishOnlinePlayers();

  // Envia jogos ativos
  socket.emit('games-update', activeGames);

  // Envia status do mercado atual
  socket.emit('market-status', marketManager.getStatus());

  socket.on('disconnect', () => {
    console.log('Cliente desconectado:', socket.id);
    connectedClients = Math.max(0, connectedClients - 1);
    publishOnlinePlayers();
  });
});

const PORT = env.PORT;
httpServer.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`WebSocket disponível em ws://localhost:${PORT}`);
});
