import { getBetsDb } from './mongodb.js';

class UsersService {
  async getUser(userId) {
    try {
      const db = await getBetsDb();
      const usersCollection = db.collection('users');

      let user = await usersCollection.findOne({ userId });

      if(!user) {
        return {
          success: false,
          user: null,
        }
      }
      return {
        success: true,
        user
      };
    } catch (error) {
      console.error('[UsersService] Erro ao buscar usuário:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getUser(userId) {
    try {
      const db = await getBetsDb();
      const usersCollection = db.collection('users');

      const user = await usersCollection.findOne({ userId });

      if (!user) {
        return {
          success: false,
          error: 'Usuário não encontrado'
        };
      }

      return {
        success: true,
        user
      };
    } catch (error) {
      console.error('[UsersService] Erro ao buscar usuário:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async updateBalance(userId, amount, operation = 'add') {
    try {
      const db = await getBetsDb();
      const usersCollection = db.collection('users');

      const increment = operation === 'add' ? amount : -amount;

      const result = await usersCollection.findOneAndUpdate(
        { userId },
        {
          $inc: { balance: increment },
          $set: { updatedAt: new Date() }
        },
        {
          returnDocument: 'after'
        }
      );

      if (!result) {
        return {
          success: false,
          error: 'Usuário não encontrado'
        };
      }

      console.log(`[UsersService] Saldo atualizado: ${userId} ${operation === 'add' ? '+' : '-'}${amount} = ${result.balance}`);

      return {
        success: true,
        user: result
      };
    } catch (error) {
      console.error('[UsersService] Erro ao atualizar saldo:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async deductBalance(userId, amount) {
    try {
      const db = await getBetsDb();
      const usersCollection = db.collection('users');

      const user = await usersCollection.findOne({ userId });

      if (!user) {
        return {
          success: false,
          error: 'Usuário não encontrado'
        };
      }

      // Valida se há saldo suficiente
      if (user.balance < amount) {
        return {
          success: false,
          error: 'Saldo insuficiente',
          currentBalance: user.balance,
          required: amount
        };
      }

      // Deduz o saldo
      const result = await usersCollection.findOneAndUpdate(
        { userId },
        {
          $inc: {
            balance: -amount,
            totalBets: 1
          },
          $set: { updatedAt: new Date() }
        },
        {
          returnDocument: 'after'
        }
      );

      console.log(`[UsersService] ✅ Saldo deduzido: ${userId} -${amount} = ${result.balance}`);

      return {
        success: true,
        user: result,
        newBalance: result.balance
      };
    } catch (error) {
      console.error('[UsersService] Erro ao deduzir saldo:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async addBalance(userId, amount, isWin = true) {
    try {
      const db = await getBetsDb();
      const usersCollection = db.collection('users');

      const updateFields = {
        $inc: {
          balance: amount
        },
        $set: {
          updatedAt: new Date()
        }
      };

      if (isWin) {
        updateFields.$inc.totalWon = amount;
      }

      const result = await usersCollection.findOneAndUpdate(
        { userId },
        updateFields,
        {
          returnDocument: 'after'
        }
      );

      if (!result) {
        return {
          success: false,
          error: 'Usuário não encontrado'
        };
      }

      console.log(`[UsersService] ✅ Saldo adicionado: ${userId} +${amount} = ${result.balance}`);

      return {
        success: true,
        user: result,
        newBalance: result.balance
      };
    } catch (error) {
      console.error('[UsersService] Erro ao adicionar saldo:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async recordLoss(userId, amount) {
    try {
      const db = await getBetsDb();
      const usersCollection = db.collection('users');

      const result = await usersCollection.findOneAndUpdate(
        { userId },
        {
          $inc: { totalLost: amount },
          $set: { updatedAt: new Date() }
        },
        {
          returnDocument: 'after'
        }
      );

      if (!result) {
        return {
          success: false,
          error: 'Usuário não encontrado'
        };
      }

      return {
        success: true,
        user: result
      };
    } catch (error) {
      console.error('[UsersService] Erro ao registrar perda:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async addBalanceManual(userId, amount, reason = 'Adição manual') {
    try {
      await this.getOrCreateUser(userId);
      const result = await this.addBalance(userId, amount, false);

      if (!result.success) {
        return result;
      }

      console.log(`[UsersService] 💰 Saldo adicionado manualmente: ${userId} +${amount} (${reason})`);

      return {
        success: true,
        user: result.user,
        newBalance: result.newBalance,
        message: `Saldo adicionado: R$ ${amount}`
      };
    } catch (error) {
      console.error('[UsersService] Erro ao adicionar saldo manualmente:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async resetBalance(userId, newBalance = 1000) {
    try {
      const db = await getBetsDb();
      const usersCollection = db.collection('users');

      const result = await usersCollection.findOneAndUpdate(
        { userId },
        {
          $set: {
            balance: newBalance,
            updatedAt: new Date()
          }
        },
        {
          returnDocument: 'after'
        }
      );

      if (!result) {
        return {
          success: false,
          error: 'Usuário não encontrado'
        };
      }

      console.log(`[UsersService] 🔄 Saldo resetado: ${userId} = ${newBalance}`);

      return {
        success: true,
        user: result,
        newBalance: result.balance
      };
    } catch (error) {
      console.error('[UsersService] Erro ao resetar saldo:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async getAllUsers(limit = 100) {
    try {
      const db = await getBetsDb();
      const usersCollection = db.collection('users');

      const users = await usersCollection
        .find({})
        .sort({ createdAt: -1 })
        .limit(limit)
        .toArray();

      return {
        success: true,
        users,
        count: users.length
      };
    } catch (error) {
      console.error('[UsersService] Erro ao listar usuários:', error);
      return {
        success: false,
        error: error.message,
        users: []
      };
    }
  }
}

export const usersService = new UsersService();
export { UsersService };
