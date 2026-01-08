import { createClient } from 'redis';
import env from './env/index.js';

// Mapeamento de eventos da API para eventos do usuário
const EVENT_TYPE_MAPPING = {
  "throw_in": "side",           // arremesso lateral
  "free_kick": "foul",           // falta / tiro livre
  "yellow_card": null,         // cartão amarelo (não mapeado)
  "red_card": null,            // cartão vermelho (não mapeado)
  "goal_kick": null,             // tiro de meta (não mapeado)
  "corner_kick": "corner",       // escanteio
  "shot_on_target": null,        // chute no alvo (não mapeado)
  "shot_saved": null,            // defesa do goleiro (não mapeado)
  "shot_off_target": null,       // chute para fora (não mapeado)
  "injury_return": null,         // retorno de lesão (não mapeado)
  "injury": null,                // lesão (não mapeado)
  "goal": "goal",                // gol
  "offside": null                // impedimento (não mapeado)
};

// Nomes legíveis dos eventos
const EVENT_NAMES = {
  "throw_in": "Arremesso Lateral",
  "free_kick": "Falta / Tiro Livre",
  "yellow_card": "Cartão Amarelo",
  "red_card": "Cartão Vermelho",
  "goal_kick": "Tiro de Meta",
  "corner_kick": "Escanteio",
  "shot_on_target": "Chute no Alvo",
  "shot_saved": "Defesa do Goleiro",
  "shot_off_target": "Chute para Fora",
  "injury_return": "Retorno de Lesão",
  "injury": "Lesão",
  "goal": "Gol",
  "offside": "Impedimento"
};

class EventValidator {
  constructor(io) {
    this.io = io;
    this.subscribers = new Map(); // Map<gameId, RedisClient>
    this.gameEvents = new Map();  // Map<marketId, Array<events>>
    this.redisPublisher = null;
  }

  async initialize() {
    // Criar cliente Redis para publicar eventos
    this.redisPublisher = createClient({
      socket: {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
      },
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
    });

    await this.redisPublisher.connect();
    console.log('[EventValidator] Redis publisher connected');
  }

  /**
   * Inicia a escuta de eventos para um jogo específico
   */
  async startListeningToGame(gameId, marketId) {
    // Se já estiver escutando este jogo, não criar novo subscriber
    if (this.subscribers.has(gameId)) {
      console.log(`[EventValidator] Já está escutando eventos do jogo ${gameId}`);
      return;
    }

    // Formata o canal: substitui o último ':' por '_id:'
    // sr:sport_event:56418573 → sr:sport_event_id:56418573
    const eventId = gameId.split(':').pop();
    const channel = `sr:sport_event_id:${eventId}`;
    console.log(`[EventValidator] Iniciando escuta no canal: ${channel} para mercado ${marketId}`);

    // Criar subscriber específico para este jogo
    const subscriber = createClient({
      socket: {
        host: env.REDIS_HOST,
        port: env.REDIS_PORT,
      },
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
    });

    subscriber.on('error', (error) => {
      console.error(`[EventValidator] Erro no subscriber do jogo ${gameId}:`, error);
    });

    await subscriber.connect();

    // Handler de mensagens
    const messageHandler = async (message) => {
      try {
        const data = JSON.parse(message);
        await this.handleGameEvent(gameId, marketId, data);
      } catch (error) {
        console.error(`[EventValidator] Erro ao processar evento do jogo ${gameId}:`, error);
      }
    };

    // Subscrever ao canal
    await subscriber.subscribe(channel, messageHandler);
    this.subscribers.set(gameId, subscriber);

    // Inicializar array de eventos para este mercado
    if (!this.gameEvents.has(marketId)) {
      this.gameEvents.set(marketId, []);
    }

    console.log(`[EventValidator] Escutando eventos do jogo ${gameId} no canal ${channel}`);
  }

  /**
   * Para a escuta de eventos de um jogo
   */
  async stopListeningToGame(gameId) {
    const subscriber = this.subscribers.get(gameId);
    if (!subscriber) {
      return;
    }

    try {
      await subscriber.unsubscribe();
      await subscriber.quit();
      this.subscribers.delete(gameId);
      console.log(`[EventValidator] Parou de escutar eventos do jogo ${gameId}`);
    } catch (error) {
      console.error(`[EventValidator] Erro ao parar escuta do jogo ${gameId}:`, error);
    }
  }

  /**
   * Processa um evento recebido do jogo
   */
  async handleGameEvent(gameId, marketId, data) {
    if (!data.event || !data.event.type) {
      return;
    }

    const eventType = data.event.type;
    const mappedEventType = EVENT_TYPE_MAPPING[eventType];

    console.log(`[EventValidator] Evento recebido - Jogo: ${gameId}, Tipo: ${eventType}, Mapeado: ${mappedEventType}`);

    // Criar objeto do evento
    const gameEvent = {
      gameId,
      marketId,
      originalType: eventType,
      mappedType: mappedEventType,
      eventName: EVENT_NAMES[eventType] || eventType,
      timestamp: data.event.time || new Date().toISOString(),
      matchTime: data.event.match_time,
      matchClock: data.event.match_clock,
      competitor: data.event.competitor, // home ou away
      period: data.event.period,
      periodType: data.event.period_type,
      x: data.event.x,
      y: data.event.y,
      status: data.sport_event_status?.status,
      matchStatus: data.sport_event_status?.match_status,
      homeScore: data.sport_event_status?.home_score,
      awayScore: data.sport_event_status?.away_score
    };

    // Adicionar evento ao histórico do mercado
    let events = this.gameEvents.get(marketId) || [];
    events.push(gameEvent);
    this.gameEvents.set(marketId, events);

    // Emitir evento em tempo real via Socket.IO
    this.io.emit('game-event', {
      gameId,
      marketId,
      event: gameEvent
    });

    // Publicar no Redis para o admin dashboard
    await this.publishEventToRedis(gameEvent);

    // Se o evento é mapeado para um tipo de aposta, validar apostas
    if (mappedEventType) {
      await this.validateBets(marketId, gameId, mappedEventType, gameEvent);
    }

    // Log do evento
    console.log(`[EventValidator] Evento processado:`, {
      gameId,
      marketId,
      eventType,
      mappedEventType,
      eventName: gameEvent.eventName,
      competitor: gameEvent.competitor,
      matchTime: gameEvent.matchTime
    });
  }

  /**
   * Valida apostas baseado em um evento
   */
  async validateBets(marketId, gameId, eventType, gameEvent) {
    console.log(`[EventValidator] Validando apostas - Market: ${marketId}, Game: ${gameId}, EventType: ${eventType}`);

    // Buscar todas as apostas do mercado
    const betsResult = await this.betsService.getBetsByMarket(marketId);
    if (!betsResult.success || !betsResult.bets) {
      console.log(`[EventValidator] Nenhuma aposta encontrada para o mercado ${marketId}`);
      return;
    }

    // Filtrar apostas relevantes (que ainda não foram resolvidas e são do tipo de evento correto)
    const relevantBets = betsResult.bets.filter(bet =>
      bet.status === 'pending' &&
      bet.eventType === eventType &&
      bet.gameId === gameId
    );

    console.log(`[EventValidator] ${relevantBets.length} apostas relevantes encontradas`);

    // Para cada aposta relevante, registrar o evento
    for (const bet of relevantBets) {
      await this.betsService.addBetLog(bet.betId, {
        type: 'event_occurred',
        eventType: gameEvent.originalType,
        mappedType: gameEvent.mappedType,
        eventName: gameEvent.eventName,
        gameId,
        marketId,
        competitor: gameEvent.competitor,
        matchTime: gameEvent.matchTime,
        matchClock: gameEvent.matchClock,
        timestamp: gameEvent.timestamp,
        betEventType: bet.eventType,
        betSelectedSide: bet.selectedSide
      });

      console.log(`[EventValidator] Log adicionado à aposta ${bet.betId}:`, {
        eventType: gameEvent.eventName,
        matchTime: gameEvent.matchTime
      });
    }
  }

  /**
   * Publica evento no Redis para dashboard admin
   */
  async publishEventToRedis(gameEvent) {
    try {
      const message = JSON.stringify({
        type: 'game-event',
        event: gameEvent,
        emittedAt: new Date().toISOString()
      });

      await this.redisPublisher.publish('prj-nextplay', message);
    } catch (error) {
      console.error('[EventValidator] Erro ao publicar evento no Redis:', error);
    }
  }

  /**
   * Para todos os subscribers ativos
   */
  async shutdown() {
    console.log('[EventValidator] Encerrando todos os subscribers...');

    for (const [gameId, subscriber] of this.subscribers.entries()) {
      try {
        await subscriber.unsubscribe();
        await subscriber.quit();
        console.log(`[EventValidator] Subscriber do jogo ${gameId} encerrado`);
      } catch (error) {
        console.error(`[EventValidator] Erro ao encerrar subscriber do jogo ${gameId}:`, error);
      }
    }

    this.subscribers.clear();

    if (this.redisPublisher) {
      await this.redisPublisher.quit();
    }

    console.log('[EventValidator] Todos os subscribers encerrados');
  }

  /**
   * Retorna eventos de um mercado
   */
  getMarketEvents(marketId) {
    return this.gameEvents.get(marketId) || [];
  }

  /**
   * Limpa eventos de um mercado da memória
   */
  clearMarketEvents(marketId) {
    this.gameEvents.delete(marketId);
    console.log(`[EventValidator] Eventos do mercado ${marketId} limpos da memória`);
  }
}

export default EventValidator;
