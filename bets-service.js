import { getBetsDb } from './mongodb.js';

/**
 * Serviço de Apostas
 * Gerencia apostas, logs e mercados
 */
class BetsService {
  constructor() {
    this.currentMarketId = null;
    this.currentMarket = null;
  }

  /**
   * Gera um ID único para o mercado baseado no timestamp de abertura
   * Formato: market_YYYYMMDD_HHMMSS_mmm
   */
  generateMarketId() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');
    const milliseconds = String(now.getMilliseconds()).padStart(3, '0');

    return `market_${year}${month}${day}_${hours}${minutes}${seconds}_${milliseconds}`;
  }

  /**
   * Abre um novo mercado
   * Chamado quando o MarketManager abre o mercado para apostas
   */
  async openMarket() {
    try {
      const db = await getBetsDb();
      const marketsCollection = db.collection('markets');

      this.currentMarketId = this.generateMarketId();
      const marketData = {
        marketId: this.currentMarketId,
        status: 'betting',
        openedAt: new Date(),
        closedAt: null,
        gameStartedAt: null,
        gameEndedAt: null,
        processedAt: null,
        totalBets: 0,
        totalAmount: 0,
        totalPayout: null,
        results: null,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      const result = await marketsCollection.insertOne(marketData);
      this.currentMarket = { ...marketData, _id: result.insertedId };

      console.log(`[BetsService] 📢 Novo mercado aberto: ${this.currentMarketId}`);

      return {
        success: true,
        marketId: this.currentMarketId,
        market: this.currentMarket
      };
    } catch (error) {
      console.error('[BetsService] Erro ao abrir mercado:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Fecha o mercado atual
   * Chamado quando o MarketManager fecha o mercado
   */
  async closeMarket() {
    if (!this.currentMarketId) {
      console.log('[BetsService] Nenhum mercado aberto para fechar');
      return { success: false, error: 'Nenhum mercado aberto' };
    }

    try {
      const db = await getBetsDb();
      const marketsCollection = db.collection('markets');

      await marketsCollection.updateOne(
        { marketId: this.currentMarketId },
        {
          $set: {
            status: 'game',
            closedAt: new Date(),
            gameStartedAt: new Date(),
            updatedAt: new Date()
          }
        }
      );

      console.log(`[BetsService] 🔒 Mercado fechado: ${this.currentMarketId}`);

      return { success: true, marketId: this.currentMarketId };
    } catch (error) {
      console.error('[BetsService] Erro ao fechar mercado:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Finaliza o jogo do mercado atual
   */
  async endGame() {
    if (!this.currentMarketId) {
      return { success: false, error: 'Nenhum mercado aberto' };
    }

    try {
      const db = await getBetsDb();
      const marketsCollection = db.collection('markets');

      await marketsCollection.updateOne(
        { marketId: this.currentMarketId },
        {
          $set: {
            status: 'processing',
            gameEndedAt: new Date(),
            updatedAt: new Date()
          }
        }
      );

      console.log(`[BetsService] 🏁 Jogo finalizado: ${this.currentMarketId}`);

      return { success: true, marketId: this.currentMarketId };
    } catch (error) {
      console.error('[BetsService] Erro ao finalizar jogo:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Processa os resultados do mercado
   */
  async processMarket(results) {
    if (!this.currentMarketId) {
      return { success: false, error: 'Nenhum mercado aberto' };
    }

    try {
      const db = await getBetsDb();
      const marketsCollection = db.collection('markets');

      // Atualiza o mercado com os resultados (status ainda é 'processing')
      await marketsCollection.updateOne(
        { marketId: this.currentMarketId },
        {
          $set: {
            processedAt: new Date(),
            results: results,
            updatedAt: new Date()
          }
        }
      );

      console.log(`[BetsService] ✅ Mercado processado: ${this.currentMarketId}`);

      return { success: true, marketId: this.currentMarketId };
    } catch (error) {
      console.error('[BetsService] Erro ao processar mercado:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Completa o mercado após todas as apostas serem processadas
   * Calcula o total pago em prêmios e atualiza o status final
   */
  async completeMarket(marketId = null) {
    const targetMarketId = marketId || this.currentMarketId;

    if (!targetMarketId) {
      return { success: false, error: 'Nenhum mercado especificado' };
    }

    try {
      const db = await getBetsDb();
      const marketsCollection = db.collection('markets');
      const betsCollection = db.collection('bets');

      // Calcula o total de payouts das apostas ganhas deste mercado
      const bets = await betsCollection
        .find({ marketId: targetMarketId, status: 'won' })
        .toArray();

      const totalPayout = bets.reduce((sum, bet) => sum + (bet.payout || 0), 0);

      // Atualiza o mercado com status 'completed' e totalPayout
      await marketsCollection.updateOne(
        { marketId: targetMarketId },
        {
          $set: {
            status: 'completed',
            totalPayout: totalPayout,
            completedAt: new Date(),
            updatedAt: new Date()
          }
        }
      );

      console.log(`[BetsService] 🏆 Mercado concluído: ${targetMarketId} (Total pago: R$ ${totalPayout})`);

      // Limpa o mercado atual se for o mercado atual (prepara para o próximo)
      if (targetMarketId === this.currentMarketId) {
        this.currentMarketId = null;
        this.currentMarket = null;
      }

      return {
        success: true,
        marketId: targetMarketId,
        totalPayout
      };
    } catch (error) {
      console.error('[BetsService] Erro ao completar mercado:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Retorna o ID do mercado atual
   */
  getCurrentMarketId() {
    return this.currentMarketId;
  }

  /**
   * Verifica se há um mercado aberto
   */
  hasOpenMarket() {
    return this.currentMarketId !== null;
  }

  /**
   * Verifica se o usuário já apostou no mercado atual
   */
  async hasUserBetInMarket(userId, marketId) {
    try {
      const db = await getBetsDb();
      const betsCollection = db.collection('bets');

      const existingBet = await betsCollection.findOne({
        userId,
        marketId
      });

      return existingBet !== null;
    } catch (error) {
      console.error('[BetsService] Erro ao verificar aposta duplicada:', error);
      return false;
    }
  }

  /**
   * Realiza uma aposta
   */
  async placeBet(betData) {
    const { userId, gameId, gameName, eventType, amount, selectedSide, odd } = betData;

    // Validação: deve haver um mercado aberto
    if (!this.currentMarketId) {
      return {
        success: false,
        error: 'Nenhum mercado aberto para apostas no momento'
      };
    }

    // Validação: usuário não pode apostar duas vezes no mesmo mercado
    const hasAlreadyBet = await this.hasUserBetInMarket(userId, this.currentMarketId);
    if (hasAlreadyBet) {
      return {
        success: false,
        error: 'Você já realizou uma aposta neste mercado. Aguarde o próximo ciclo.'
      };
    }

    try {
      const db = await getBetsDb();
      const betsCollection = db.collection('bets');
      const marketsCollection = db.collection('markets');
      const { ObjectId } = await import('mongodb');

      // Gera ID único para a aposta
      const betId = new ObjectId();

      // Calcula potencial de ganho
      const potentialWin = Math.floor(amount * odd);

      // Cria o documento da aposta
      const bet = {
        _id: betId,
        betId: betId.toString(),
        userId,
        gameId,
        gameName,
        marketId: this.currentMarketId,
        eventType,
        selectedSide,
        amount,
        odd,
        potentialWin,
        status: 'pending',
        payout: null,
        refund: null,
        resultReason: null,
        eventsCount: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        processedAt: null
      };

      // Insere a aposta no banco
      await betsCollection.insertOne(bet);

      // Atualiza contadores do mercado
      await marketsCollection.updateOne(
        { marketId: this.currentMarketId },
        {
          $inc: {
            totalBets: 1,
            totalAmount: amount
          },
          $set: {
            updatedAt: new Date()
          }
        }
      );

      // Cria log inicial da aposta
      await this.createBetLog({
        betId: bet.betId,
        userId,
        action: 'bet_placed',
        message: 'Aposta realizada com sucesso',
        marketId: this.currentMarketId,
        metadata: {
          gameId,
          gameName,
          eventType,
          selectedSide,
          amount,
          odd,
          potentialWin
        }
      });

      console.log(`[BetsService] ✅ Aposta criada:`, {
        betId: bet.betId,
        userId,
        gameId,
        eventType,
        amount,
        odd,
        potentialWin
      });

      return {
        success: true,
        betId: bet.betId,
        marketId: this.currentMarketId,
        bet
      };
    } catch (error) {
      console.error('[BetsService] Erro ao criar aposta:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Cria um log de aposta
   */
  async createBetLog(logData) {
    try {
      const db = await getBetsDb();
      const logsCollection = db.collection('bet_logs');

      const log = {
        betId: logData.betId,
        userId: logData.userId,
        action: logData.action,
        message: logData.message,
        marketId: logData.marketId,
        metadata: logData.metadata || {},
        errorMessage: logData.errorMessage || null,
        createdAt: new Date()
      };

      await logsCollection.insertOne(log);

      return { success: true };
    } catch (error) {
      console.error('[BetsService] Erro ao criar log:', error);
      // Não lançar erro para não afetar a operação principal
      return { success: false, error: error.message };
    }
  }

  /**
   * Busca apostas de um mercado específico
   */
  async getBetsByMarket(marketId) {
    try {
      const db = await getBetsDb();
      const betsCollection = db.collection('bets');

      const bets = await betsCollection
        .find({ marketId })
        .sort({ createdAt: -1 })
        .toArray();

      return {
        success: true,
        bets
      };
    } catch (error) {
      console.error('[BetsService] Erro ao buscar apostas:', error);
      return {
        success: false,
        error: error.message,
        bets: []
      };
    }
  }

  /**
   * Busca apostas de um usuário
   */
  async getBetsByUser(userId, limit = 50) {
    try {
      const db = await getBetsDb();
      const betsCollection = db.collection('bets');

      const bets = await betsCollection
        .find({ userId })
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      return {
        success: true,
        bets
      };
    } catch (error) {
      console.error('[BetsService] Erro ao buscar apostas do usuário:', error);
      return {
        success: false,
        error: error.message,
        bets: []
      };
    }
  }

  /**
   * Busca logs de uma aposta
   */
  async getBetLogs(betId) {
    try {
      const db = await getBetsDb();
      const logsCollection = db.collection('bet_logs');

      const logs = await logsCollection
        .find({ betId })
        .sort({ createdAt: 1 })
        .toArray();

      return {
        success: true,
        logs
      };
    } catch (error) {
      console.error('[BetsService] Erro ao buscar logs:', error);
      return {
        success: false,
        error: error.message,
        logs: []
      };
    }
  }

  /**
   * Busca informações de um mercado
   */
  async getMarket(marketId) {
    try {
      const db = await getBetsDb();
      const marketsCollection = db.collection('markets');

      const market = await marketsCollection.findOne({ marketId });

      if (!market) {
        return {
          success: false,
          error: 'Mercado não encontrado'
        };
      }

      return {
        success: true,
        market
      };
    } catch (error) {
      console.error('[BetsService] Erro ao buscar mercado:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Busca estatísticas gerais
   */
  async getStats() {
    try {
      const db = await getBetsDb();
      const betsCollection = db.collection('bets');
      const marketsCollection = db.collection('markets');

      const [totalBets, totalMarkets, activeBets] = await Promise.all([
        betsCollection.countDocuments(),
        marketsCollection.countDocuments(),
        betsCollection.countDocuments({ status: 'pending' })
      ]);

      return {
        success: true,
        stats: {
          totalBets,
          totalMarkets,
          activeBets,
          currentMarketId: this.currentMarketId
        }
      };
    } catch (error) {
      console.error('[BetsService] Erro ao buscar estatísticas:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Busca estatísticas do dia
   */
  async getDailyStats() {
    try {
      const db = await getBetsDb();
      const betsCollection = db.collection('bets');
      const marketsCollection = db.collection('markets');

      // Início do dia (00:00:00)
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      // Apostas ativas (pending)
      const activeBets = await betsCollection.countDocuments({
        status: 'pending'
      });

      // Apostas de hoje
      const todayBets = await betsCollection.find({
        createdAt: { $gte: startOfDay }
      }).toArray();

      // Total apostado hoje (soma dos amounts)
      const totalBetAmount = todayBets.reduce((sum, bet) => sum + bet.amount, 0);

      // Total ganho hoje (soma dos payouts das apostas ganhas)
      const wonBetsToday = todayBets.filter(bet => bet.status === 'won');
      const totalWonAmount = wonBetsToday.reduce((sum, bet) => sum + (bet.payout || 0), 0);

      // Lucro da casa = Total apostado - Total pago
      const houseProfit = totalBetAmount - totalWonAmount;

      // Rodadas hoje (mercados criados hoje)
      const todayMarkets = await marketsCollection.countDocuments({
        createdAt: { $gte: startOfDay }
      });

      return {
        success: true,
        stats: {
          activeBets,
          totalBetAmountToday: totalBetAmount,
          totalWonAmountToday: totalWonAmount,
          houseProfit,
          marketsToday: todayMarkets
        }
      };
    } catch (error) {
      console.error('[BetsService] Erro ao buscar estatísticas do dia:', error);
      return {
        success: false,
        error: error.message,
        stats: {
          activeBets: 0,
          totalBetAmountToday: 0,
          totalWonAmountToday: 0,
          houseProfit: 0,
          marketsToday: 0
        }
      };
    }
  }

  /**
   * Atualiza o status de uma aposta
   */
  async updateBetStatus(betId, status, resultData = {}) {
    try {
      const db = await getBetsDb();
      const betsCollection = db.collection('bets');
      const { ObjectId } = await import('mongodb');

      const updateData = {
        status,
        updatedAt: new Date(),
        processedAt: new Date()
      };

      // Adiciona dados do resultado
      if (resultData.winAmount !== undefined) {
        updateData.payout = resultData.winAmount;
      }

      if (resultData.refundAmount !== undefined) {
        updateData.refund = resultData.refundAmount;
      }

      if (resultData.resultReason !== undefined) {
        updateData.resultReason = resultData.resultReason;
      }

      if (resultData.eventsCount !== undefined) {
        updateData.eventsCount = resultData.eventsCount;
      }

      const result = await betsCollection.updateOne(
        { _id: new ObjectId(betId) },
        { $set: updateData }
      );

      if (result.matchedCount === 0) {
        return {
          success: false,
          error: 'Aposta não encontrada'
        };
      }

      console.log(`[BetsService] ✅ Aposta ${betId} atualizada para status: ${status}`);

      return {
        success: true,
        betId,
        status
      };
    } catch (error) {
      console.error('[BetsService] Erro ao atualizar status da aposta:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Adiciona um log a uma aposta
   */
  async addBetLog(betId, logData) {
    try {
      const db = await getBetsDb();
      const logsCollection = db.collection('bet_logs');

      const log = {
        betId,
        type: logData.type,
        timestamp: logData.timestamp || new Date().toISOString(),
        data: logData,
        createdAt: new Date()
      };

      await logsCollection.insertOne(log);

      console.log(`[BetsService] 📝 Log adicionado à aposta ${betId}: ${logData.type}`);

      return { success: true };
    } catch (error) {
      console.error('[BetsService] Erro ao adicionar log:', error);
      return { success: false, error: error.message };
    }
  }
}

// Exporta uma instância única do serviço
export const betsService = new BetsService();

// Exporta também a classe para testes
export { BetsService };
