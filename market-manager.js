/**
 * Market Manager - Gerencia o ciclo automático de apostas
 *
 * Fluxo automático e cíclico:
 * 1. Mercado aberto (10s, pode ser alterado pelo ADMIN) - Usuários podem apostar
 * 2. Mercado fechado automaticamente
 * 3. Jogo em andamento (60s, pode ser alterado pelo ADMIN) - Timer do jogo
 * 4. Processamento de apostas
 * 5. Intervalo (10s, pode ser alterado pelo ADMIN) - Preparação para próxima rodada
 * 6. Volta para o passo 1 (automaticamente)
 */

class MarketManager {
  constructor(io, redisPublisher = null, betsService = null, eventValidator = null, activeGamesGetter = null) {
    this.io = io;
    this.redisPublisher = redisPublisher;
    this.betsService = betsService;
    this.eventValidator = eventValidator;
    this.getActiveGames = activeGamesGetter || (() => []); // Função para pegar jogos ativos
    this.isMarketOpen = false;
    this.bettingTimer = null;
    this.gameTimer = null;
    this.intervalTimer = null;
    this.countdownInterval = null;
    this.bettingTimeRemaining = 0;
    this.gameTimeRemaining = 0;
    this.intervalTimeRemaining = 0;
    this.currentMarketId = null; // ID do mercado atual

    // Configurações de tempo (em segundos)
    this.BETTING_DURATION = 10;
    this.GAME_DURATION = 60;
    this.INTERVAL_DURATION = 10;

    this.status = 'stopped'; // stopped, betting, game, processing, interval
    this.isAutomatic = false; // Controla se o ciclo é automático

    // Constantes do Redis para o frontend-next (admin)
    this.REDIS_MARKET_CHANNEL = 'prj-nextplay';
    this.REDIS_MARKET_KEY = 'market-status:latest';
    this.REDIS_LIMITS_KEY = 'limits:latest';
  }

  /**
   * Busca configurações de tempo do Redis
   */
  async loadTimeSettings() {
    if (!this.redisPublisher) {
      console.log('[MarketManager] Redis não disponível, usando tempos padrão');
      return;
    }

    try {
      const value = await this.redisPublisher.get(`${this.REDIS_MARKET_CHANNEL}:${this.REDIS_LIMITS_KEY}`);

      if (value) {
        const parsed = JSON.parse(value);
        if (parsed.type === 'limits' && parsed.limits) {
          const { bettingTime, playTime, waitingTime } = parsed.limits;

          this.BETTING_DURATION = bettingTime || 10;
          this.GAME_DURATION = playTime || 60;
          this.INTERVAL_DURATION = waitingTime || 10;

          console.log('[MarketManager] Tempos carregados do Redis:', {
            betting: this.BETTING_DURATION,
            game: this.GAME_DURATION,
            interval: this.INTERVAL_DURATION
          });
        }
      }
    } catch (error) {
      console.error('[MarketManager] Erro ao carregar tempos do Redis:', error);
    }
  }

  /**
   * Inicia o ciclo automático
   */
  async startAutomaticCycle() {
    if (this.isAutomatic) {
      console.log('[MarketManager] Ciclo automático já está rodando');
      return false;
    }

    // Carrega configurações de tempo do Redis antes de iniciar
    await this.loadTimeSettings();

    this.isAutomatic = true;
    console.log('[MarketManager] 🟢 Iniciando ciclo automático');

    // Inicia imediatamente com a fase de apostas
    this.openMarket();

    return true;
  }

  /**
   * Para o ciclo automático
   */
  stopAutomaticCycle() {
    this.isAutomatic = false;
    this.isMarketOpen = false;
    this.clearAllTimers();
    this.status = 'stopped';
    this.bettingTimeRemaining = 0;
    this.gameTimeRemaining = 0;
    this.intervalTimeRemaining = 0;

    console.log('[MarketManager] 🔴 Ciclo automático parado');
    this.broadcastMarketStatus();

    return true;
  }

  /**
   * Abre o mercado para apostas
   */
  async openMarket() {
    if (this.isMarketOpen) {
      console.log('[MarketManager] Mercado já está aberto');
      return false;
    }

    this.isMarketOpen = true;
    this.bettingTimeRemaining = this.BETTING_DURATION;
    this.status = 'betting';

    console.log(`[MarketManager] 📢 Mercado aberto para apostas (${this.BETTING_DURATION}s)`);

    // Abre o mercado no BetsService
    if (this.betsService) {
      const result = await this.betsService.openMarket();
      if (result.success) {
        this.currentMarketId = result.marketId;
        console.log(`[MarketManager] ✅ Mercado de apostas criado: ${result.marketId}`);

        // Inicia escuta de eventos dos jogos ativos
        await this.startEventListeners(result.marketId);
      } else {
        console.error('[MarketManager] ❌ Erro ao criar mercado de apostas:', result.error);
      }
    }

    // Broadcast inicial
    this.broadcastMarketStatus();

    // Inicia o countdown
    this.startCountdown();

    return true;
  }

  /**
   * Inicia escuta de eventos para os jogos ativos
   */
  async startEventListeners(marketId) {
    if (!this.eventValidator) {
      console.log('[MarketManager] EventValidator não disponível');
      return;
    }

    const activeGames = this.getActiveGames();
    console.log(`[MarketManager] Iniciando escuta de eventos para ${activeGames.length} jogos ativos`);

    for (const game of activeGames) {
      await this.eventValidator.startListeningToGame(game.id, marketId);
    }
  }

  /**
   * Para escuta de eventos dos jogos ativos
   */
  async stopEventListeners() {
    if (!this.eventValidator) {
      return;
    }

    const activeGames = this.getActiveGames();
    console.log(`[MarketManager] Parando escuta de eventos de ${activeGames.length} jogos`);

    for (const game of activeGames) {
      await this.eventValidator.stopListeningToGame(game.id);
    }
  }

  /**
   * Countdown unificado - atualiza a cada segundo
   */
  startCountdown() {
    this.clearCountdown();

    this.countdownInterval = setInterval(() => {
      // Decrementa o timer apropriado baseado no status
      if (this.status === 'betting' && this.bettingTimeRemaining > 0) {
        this.bettingTimeRemaining--;
        this.broadcastMarketStatus();

        if (this.bettingTimeRemaining <= 0) {
          this.closeMarket();
        }
      } else if (this.status === 'game' && this.gameTimeRemaining > 0) {
        this.gameTimeRemaining--;
        this.broadcastMarketStatus();

        if (this.gameTimeRemaining <= 0) {
          this.endGame();
        }
      } else if (this.status === 'interval' && this.intervalTimeRemaining > 0) {
        this.intervalTimeRemaining--;
        this.broadcastMarketStatus();

        if (this.intervalTimeRemaining <= 0) {
          this.endInterval();
        }
      }
    }, 1000);
  }

  /**
   * Limpa o countdown
   */
  clearCountdown() {
    if (this.countdownInterval) {
      clearInterval(this.countdownInterval);
      this.countdownInterval = null;
    }
  }

  /**
   * Fecha o mercado automaticamente e inicia o timer do jogo
   */
  async closeMarket() {
    if (!this.isMarketOpen) {
      console.log('[MarketManager] Mercado já está fechado');
      return false;
    }

    this.isMarketOpen = false;
    this.bettingTimeRemaining = 0;
    this.status = 'game';

    console.log('[MarketManager] 🔒 Mercado fechado. Iniciando jogo...');

    // Fecha o mercado no BetsService
    if (this.betsService) {
      const result = await this.betsService.closeMarket();
      if (result.success) {
        console.log(`[MarketManager] ✅ Mercado de apostas fechado: ${result.marketId}`);
      } else {
        console.error('[MarketManager] ❌ Erro ao fechar mercado de apostas:', result.error);
      }
    }

    // Broadcast que o mercado fechou
    this.broadcastMarketStatus();

    // Inicia o timer do jogo
    this.startGameTimer();

    return true;
  }

  /**
   * Inicia o timer do jogo (60 segundos)
   */
  startGameTimer() {
    this.gameTimeRemaining = this.GAME_DURATION;

    console.log(`[MarketManager] ⚽ Jogo iniciado (${this.GAME_DURATION}s)`);
    // O countdown já está rodando, apenas continua
  }

  /**
   * Finaliza o jogo e inicia processamento
   */
  async endGame() {
    this.gameTimeRemaining = 0;
    this.status = 'processing';

    console.log('[MarketManager] 🏁 Jogo finalizado. Processando apostas...');
    this.broadcastMarketStatus();

    // Para escuta de eventos
    await this.stopEventListeners();

    // Finaliza o jogo no BetsService e salva os results dos eventos
    if (this.betsService && this.eventValidator && this.currentMarketId) {
      // Finaliza jogo (muda status para 'processing')
      const result = await this.betsService.endGame();
      if (result.success) {
        console.log(`[MarketManager] ✅ Jogo finalizado no mercado: ${result.marketId}`);
      } else {
        console.error('[MarketManager] ❌ Erro ao finalizar jogo:', result.error);
      }

      // Salva os results dos eventos coletados
      console.log(`[MarketManager] 💾 Salvando results do mercado ${this.currentMarketId}`);
      const activeGames = this.getActiveGames();
      const events = this.eventValidator.getMarketEvents(this.currentMarketId);

      // Agrupar eventos por side e tipo
      const results = this.buildMarketResults(events, activeGames);

      await this.betsService.processMarket(results);
      console.log(`[MarketManager] ✅ Results salvos no mercado`);

      // Limpa eventos da memória após salvar
      this.eventValidator.clearMarketEvents(this.currentMarketId);
    }

    // Aguarda um momento antes de ir para o intervalo
    setTimeout(() => {
      this.startInterval();
    }, 2000); // 2 segundos para processar
  }

  /**
   * Inicia o intervalo antes da próxima rodada
   */
  startInterval() {
    this.intervalTimeRemaining = this.INTERVAL_DURATION;
    this.status = 'interval';

    console.log(`[MarketManager] ⏸️  Intervalo iniciado (${this.INTERVAL_DURATION}s)`);
    this.broadcastMarketStatus();
    // O countdown já está rodando, apenas continua
  }

  /**
   * Finaliza o intervalo e reinicia o ciclo (se automático)
   */
  endInterval() {
    this.intervalTimeRemaining = 0;

    console.log('[MarketManager] ✅ Intervalo finalizado');

    // Se estiver em modo automático, reinicia o ciclo
    if (this.isAutomatic) {
      console.log('[MarketManager] 🔄 Reiniciando ciclo automático...');
      this.openMarket();
    } else {
      this.status = 'stopped';
      this.broadcastMarketStatus();
    }
  }

  /**
   * Limpa todos os timers
   */
  clearAllTimers() {
    this.clearCountdown();

    if (this.bettingTimer) {
      clearInterval(this.bettingTimer);
      this.bettingTimer = null;
    }

    if (this.gameTimer) {
      clearInterval(this.gameTimer);
      this.gameTimer = null;
    }

    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Constrói a estrutura de results a partir dos eventos coletados
   */
  buildMarketResults(events, activeGames) {
    const results = {
      totalEvents: events.length,
      eventsBySide: {
        A: {
          gameId: null,
          gameName: null,
          events: []
        },
        B: {
          gameId: null,
          gameName: null,
          events: []
        }
      },
      summary: {
        side: { A: 0, B: 0 },
        corner: { A: 0, B: 0 },
        foul: { A: 0, B: 0 },
        goal: { A: 0, B: 0 }
      }
    };

    // Encontrar games A e B dos active games
    const gameA = activeGames ? activeGames.find(g => g.side === 'A') : null;
    const gameB = activeGames ? activeGames.find(g => g.side === 'B') : null;

    if (gameA) {
      results.eventsBySide.A.gameId = gameA.id;
      results.eventsBySide.A.gameName = `${gameA.home.name} vs ${gameA.away.name}`;
    }

    if (gameB) {
      results.eventsBySide.B.gameId = gameB.id;
      results.eventsBySide.B.gameName = `${gameB.home.name} vs ${gameB.away.name}`;
    }

    // Processar cada evento e agrupar por side
    for (const event of events) {
      if (!event.mappedType) continue; // Ignora eventos não mapeados

      // Determinar qual side este evento pertence
      let side = null;
      if (gameA && event.gameId === gameA.id) {
        side = 'A';
      } else if (gameB && event.gameId === gameB.id) {
        side = 'B';
      }

      if (!side) continue; // Ignora eventos de jogos não encontrados

      // Adicionar evento ao side correspondente
      results.eventsBySide[side].events.push({
        type: event.mappedType,
        originalType: event.originalType,
        eventName: event.eventName,
        timestamp: event.timestamp,
        matchTime: event.matchTime,
        competitor: event.competitor
      });

      // Incrementar contador no summary
      if (results.summary[event.mappedType]) {
        results.summary[event.mappedType][side]++;
      }
    }

    console.log(`[MarketManager] Results compilados:`, {
      totalEvents: results.totalEvents,
      sideA: results.eventsBySide.A.events.length,
      sideB: results.eventsBySide.B.events.length,
      summary: results.summary
    });

    return results;
  }

  /**
   * Broadcast do status do mercado para todos os clientes conectados
   */
  async broadcastMarketStatus() {
    const status = {
      isOpen: this.isMarketOpen,
      status: this.status,
      isAutomatic: this.isAutomatic,
      bettingTimeRemaining: this.bettingTimeRemaining,
      gameTimeRemaining: this.gameTimeRemaining,
      intervalTimeRemaining: this.intervalTimeRemaining,
      timestamp: new Date().toISOString()
    };

    // Envia via WebSocket para os clientes do jogo (frontend)
    this.io.emit('market-status', status);

    // Publica no Redis para o admin (frontend-next)
    await this.publishToRedis(status);

    // Log apenas em momentos importantes para evitar spam
    const shouldLog =
      this.bettingTimeRemaining === this.BETTING_DURATION ||
      this.bettingTimeRemaining === 0 ||
      this.gameTimeRemaining === this.GAME_DURATION ||
      this.gameTimeRemaining === 0 ||
      this.intervalTimeRemaining === this.INTERVAL_DURATION ||
      this.intervalTimeRemaining === 0 ||
      this.status === 'processing';

    if (shouldLog) {
      console.log('[MarketManager] Status:', {
        status: this.status,
        isAutomatic: this.isAutomatic,
        betting: this.bettingTimeRemaining,
        game: this.gameTimeRemaining,
        interval: this.intervalTimeRemaining
      });
    }
  }

  /**
   * Publica status no Redis para o frontend-next (admin)
   */
  async publishToRedis(backendStatus) {
    if (!this.redisPublisher) {
      return;
    }

    try {
      // Para o admin: 'open' significa que o ciclo automático está rodando
      // 'closed' significa que o ciclo está parado
      const adminStatus = backendStatus.isAutomatic ? 'open' : 'closed';

      const message = {
        type: 'market-status',
        status: adminStatus,
        emittedAt: backendStatus.timestamp
      };

      const serialized = JSON.stringify(message);

      // Publica no canal e salva a chave
      await Promise.all([
        this.redisPublisher.publish(this.REDIS_MARKET_CHANNEL, serialized),
        this.redisPublisher.set(`${this.REDIS_MARKET_CHANNEL}:${this.REDIS_MARKET_KEY}`, serialized)
      ]);

      console.log(`[MarketManager] Publicado no Redis: ${adminStatus} (isAutomatic: ${backendStatus.isAutomatic})`);
    } catch (error) {
      console.error('[MarketManager] Erro ao publicar no Redis:', error);
    }
  }

  /**
   * Retorna o status atual do mercado
   */
  getStatus() {
    return {
      isOpen: this.isMarketOpen,
      status: this.status,
      isAutomatic: this.isAutomatic,
      bettingTimeRemaining: this.bettingTimeRemaining,
      gameTimeRemaining: this.gameTimeRemaining,
      intervalTimeRemaining: this.intervalTimeRemaining
    };
  }

  /**
   * Valida se uma aposta pode ser feita no momento
   */
  canPlaceBet() {
    return this.isMarketOpen && this.status === 'betting' && this.bettingTimeRemaining > 0;
  }

  /**
   * Cleanup - limpa todos os timers
   */
  destroy() {
    this.stopAutomaticCycle();
    this.clearAllTimers();
  }
}

export default MarketManager;
