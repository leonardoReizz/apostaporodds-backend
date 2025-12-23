# API de Apostas - Documentação

## Visão Geral

Sistema de apostas integrado com MongoDB que gerencia apostas, mercados e logs. Cada mercado representa um ciclo completo de apostas (abertura → fechamento → jogo → processamento).

## Conceitos Importantes

### Mercado (Market)
Um mercado representa um ciclo completo de apostas com:
- **ID único**: Formato `market_YYYYMMDD_HHMMSS_mmm`
- **Status**: `betting`, `game`, `processing`, `closed`
- **Timestamps**: abertura, fechamento, início do jogo, fim do jogo
- **Estatísticas**: total de apostas, valor total apostado

### Separação de Mercados
As apostas são separadas por mercado baseado no ciclo de apostas:
- **Abertura do mercado**: Usuários podem fazer apostas
- **Fechamento do mercado**: Apostas não são mais aceitas, jogo começa
- **Processamento**: Resultados são calculados
- **Novo mercado**: Um novo ciclo começa automaticamente

Isso garante que apostas feitas em diferentes janelas de tempo sejam processadas separadamente.

## Estrutura de Dados

### Coleções MongoDB

#### `bets` - Apostas
```javascript
{
  _id: ObjectId,
  userId: String,              // ID do usuário
  gameId: String,              // ID do jogo (ex: "A" ou "B")
  gameName: String,            // Nome do jogo
  eventType: String,           // 'side', 'corner', 'foul', 'goal', 'atLeastOne'
  amount: Number,              // Valor apostado
  selectedSide: String,        // 'A' ou 'B'
  marketId: String,            // ID do mercado
  marketOpenedAt: Date,        // Quando o mercado foi aberto
  marketClosedAt: Date,        // Quando o mercado foi fechado
  status: String,              // 'pending', 'won', 'lost', 'refunded', 'cancelled'
  odd: Number,                 // Odd aplicada
  potentialWin: Number,        // Ganho potencial (amount * odd)
  result: String,              // Resultado do evento (null se pending)
  payout: Number,              // Valor pago (null se não ganhou)
  createdAt: Date,
  updatedAt: Date,
  processedAt: Date            // Quando foi processada
}
```

#### `bet_logs` - Logs de Apostas
```javascript
{
  _id: ObjectId,
  betId: String,               // ID da aposta
  userId: String,              // ID do usuário
  action: String,              // 'created', 'won', 'lost', 'refunded', 'cancelled', 'error'
  message: String,             // Mensagem descritiva
  marketId: String,            // ID do mercado
  metadata: Object,            // Dados adicionais
  errorMessage: String,        // Mensagem de erro (se houver)
  createdAt: Date
}
```

#### `markets` - Mercados
```javascript
{
  _id: ObjectId,
  marketId: String,            // ID único do mercado
  status: String,              // 'betting', 'game', 'processing', 'closed'
  openedAt: Date,              // Abertura do mercado
  closedAt: Date,              // Fechamento do mercado
  gameStartedAt: Date,         // Início do jogo
  gameEndedAt: Date,           // Fim do jogo
  processedAt: Date,           // Processamento completo
  totalBets: Number,           // Total de apostas
  totalAmount: Number,         // Valor total apostado
  totalPayout: Number,         // Valor total pago
  results: Object,             // Resultados do jogo
  createdAt: Date,
  updatedAt: Date
}
```

## Endpoints da API

### Usuários

#### Buscar Usuário

**GET** `/api/users/:userId`

Retorna informações do usuário. Se o usuário não existir, cria automaticamente com saldo inicial de R$ 1000.

**Resposta** (200):
```json
{
  "success": true,
  "user": {
    "userId": "user-1",
    "balance": 1000,
    "totalBets": 0,
    "totalWon": 0,
    "totalLost": 0,
    "createdAt": "2025-01-14T15:30:45.000Z",
    "updatedAt": "2025-01-14T15:30:45.000Z"
  }
}
```

---

#### Adicionar Saldo (Admin)

**POST** `/api/users/:userId/add-balance`

Adiciona saldo manualmente a um usuário (função administrativa).

**Body**:
```json
{
  "amount": 100,
  "reason": "Bônus de boas-vindas"
}
```

**Resposta** (200):
```json
{
  "success": true,
  "message": "Saldo adicionado: R$ 100",
  "user": {...},
  "newBalance": 1100
}
```

---

#### Resetar Saldo

**POST** `/api/users/:userId/reset-balance`

Reseta o saldo do usuário para um valor específico (padrão: R$ 1000).

**Body** (opcional):
```json
{
  "newBalance": 500
}
```

**Resposta** (200):
```json
{
  "success": true,
  "message": "Saldo resetado para R$ 500",
  "user": {...},
  "newBalance": 500
}
```

---

#### Listar Usuários

**GET** `/api/users?limit=100`

Lista todos os usuários cadastrados.

**Resposta** (200):
```json
{
  "success": true,
  "users": [...],
  "count": 10
}
```

---

### Apostas

#### Realizar Aposta

**POST** `/api/bets/place`

Cria uma nova aposta no mercado atual.

**Requisitos**:
- Mercado deve estar aberto (`status: 'betting'`)
- Jogo deve estar ativo
- Valor da aposta deve ser maior que 0
- Usuário deve ter saldo suficiente
- Usuário não pode ter apostado no mercado atual

**Body**:
```json
{
  "userId": "user-1",
  "gameId": "game-123",
  "eventType": "goal",
  "amount": 10,
  "selectedSide": "A"
}
```



**Resposta de Sucesso** (200):
```json
{
  "success": true,
  "message": "Aposta realizada com sucesso",
  "betId": "507f1f77bcf86cd799439011",
  "marketId": "market_20250114_153045_123",
  "newBalance": 990,
  "bet": {...}
}
```

**Erros**:
- `400`: Campos obrigatórios faltando, saldo insuficiente, ou já apostou neste mercado
- `403`: Mercado fechado ou não há mercado aberto
- `404`: Jogo não encontrado

**Exemplos de erros**:
```json
// Saldo insuficiente
{
  "error": "Saldo insuficiente",
  "currentBalance": 5,
  "required": 10
}

// Já apostou neste mercado
{
  "error": "Você já realizou uma aposta neste mercado. Aguarde o próximo ciclo."
}
```

---

### Buscar Apostas de um Usuário

**GET** `/api/bets/user/:userId?limit=50`

Retorna as apostas de um usuário específico.

**Parâmetros**:
- `userId` (path): ID do usuário
- `limit` (query, opcional): Limite de resultados (padrão: 50)

**Resposta** (200):
```json
{
  "success": true,
  "bets": [...],
  "count": 10
}
```

---

### Buscar Apostas de um Mercado

**GET** `/api/bets/market/:marketId`

Retorna todas as apostas de um mercado específico.

**Parâmetros**:
- `marketId` (path): ID do mercado

**Resposta** (200):
```json
{
  "success": true,
  "marketId": "market_20250114_153045_123",
  "bets": [...],
  "count": 25
}
```

---

### Buscar Informações de um Mercado

**GET** `/api/markets/:marketId`

Retorna informações detalhadas de um mercado.

**Resposta** (200):
```json
{
  "success": true,
  "market": {
    "marketId": "market_20250114_153045_123",
    "status": "closed",
    "openedAt": "2025-01-14T15:30:45.000Z",
    "closedAt": "2025-01-14T15:30:55.000Z",
    "gameStartedAt": "2025-01-14T15:30:55.000Z",
    "gameEndedAt": "2025-01-14T15:31:55.000Z",
    "processedAt": "2025-01-14T15:32:00.000Z",
    "totalBets": 25,
    "totalAmount": 500,
    "totalPayout": 450,
    "results": {...}
  }
}
```

---

### Buscar Mercado Atual

**GET** `/api/markets/current`

Retorna o mercado atualmente aberto (se houver).

**Resposta** (200):
```json
{
  "success": true,
  "currentMarket": {
    "marketId": "market_20250114_153045_123",
    "status": "betting",
    "openedAt": "2025-01-14T15:30:45.000Z",
    "totalBets": 5,
    "totalAmount": 100
  }
}
```

Se não houver mercado aberto:
```json
{
  "success": true,
  "currentMarket": null,
  "message": "Nenhum mercado aberto no momento"
}
```

---

### Buscar Logs de uma Aposta

**GET** `/api/bets/:betId/logs`

Retorna o histórico de logs de uma aposta.

**Resposta** (200):
```json
{
  "success": true,
  "betId": "507f1f77bcf86cd799439011",
  "logs": [
    {
      "betId": "507f1f77bcf86cd799439011",
      "userId": "user-1",
      "action": "created",
      "message": "Aposta criada: goal - A - R$ 10",
      "marketId": "market_20250114_153045_123",
      "metadata": {...},
      "createdAt": "2025-01-14T15:30:45.000Z"
    }
  ],
  "count": 1
}
```

---

### Buscar Estatísticas Gerais

**GET** `/api/bets/stats`

Retorna estatísticas gerais do sistema de apostas.

**Resposta** (200):
```json
{
  "success": true,
  "stats": {
    "totalBets": 1250,
    "totalMarkets": 50,
    "activeBets": 15,
    "currentMarketId": "market_20250114_153045_123"
  }
}
```

---

## Fluxo de Funcionamento

### 1. Abertura do Mercado
Quando o `MarketManager` abre o mercado para apostas:
```javascript
// MarketManager chama
await betsService.openMarket()

// Cria um novo documento em `markets`:
{
  marketId: "market_20250114_153045_123",
  status: "betting",
  openedAt: new Date(),
  totalBets: 0,
  totalAmount: 0
}
```

### 2. Realização de Apostas
Durante o período de apostas abertas:
```javascript
// Frontend chama
POST /api/bets/place

// Backend:
// 1. Valida se mercado está aberto
// 2. Busca odd atual do Redis
// 3. Cria aposta no MongoDB (collection: bets)
// 4. Atualiza contadores do mercado
// 5. Cria log da aposta (collection: bet_logs)
```

### 3. Fechamento do Mercado
Quando o tempo de apostas termina:
```javascript
// MarketManager chama
await betsService.closeMarket()

// Atualiza documento em `markets`:
{
  status: "game",
  closedAt: new Date(),
  gameStartedAt: new Date()
}
```

### 4. Finalização do Jogo
Quando o jogo termina:
```javascript
// MarketManager chama
await betsService.endGame()

// Atualiza documento em `markets`:
{
  status: "processing",
  gameEndedAt: new Date()
}
```

### 5. Processamento dos Resultados
Após o jogo (implementação futura):
```javascript
// MarketManager chama
await betsService.processMarket(results)

// Atualiza:
// - Mercado: status "closed", results, totalPayout
// - Apostas: status "won"/"lost", payout
// - Logs: novos logs para cada aposta processada
```

### 6. Novo Ciclo
O sistema automaticamente abre um novo mercado, iniciando um novo ciclo.

---

## Configuração

### Variáveis de Ambiente

Adicione no arquivo `.env`:
```bash
# MongoDB para apostas e logs
BETS_DATABASE_URL="mongodb://localhost:27017/bets_db"
# Ou MongoDB Atlas:
# BETS_DATABASE_URL="mongodb+srv://user:password@cluster.mongodb.net/bets_db"
```

### Índices MongoDB

Os seguintes índices são criados automaticamente na primeira conexão:

**Collection: bets**
- `userId`
- `gameId`
- `marketId`
- `status`
- `createdAt` (desc)
- `marketId + userId` (compound)

**Collection: bet_logs**
- `betId`
- `userId`
- `action`
- `createdAt` (desc)
- `marketId`

---

## Exemplos de Uso

### Fazer uma aposta
```javascript
const response = await fetch('http://localhost:4000/api/bets/place', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    userId: 'user-123',
    gameId: 'game-A',
    eventType: 'goal',
    amount: 10,
    selectedSide: 'A'
  })
});

const data = await response.json();
console.log('Aposta criada:', data.betId);
console.log('Mercado:', data.marketId);
```

### Buscar apostas do usuário
```javascript
const response = await fetch('http://localhost:4000/api/bets/user/user-123?limit=20');
const data = await response.json();
console.log(`Encontradas ${data.count} apostas`);
```

### Verificar mercado atual
```javascript
const response = await fetch('http://localhost:4000/api/markets/current');
const data = await response.json();

if (data.currentMarket) {
  console.log('Mercado aberto:', data.currentMarket.marketId);
  console.log('Status:', data.currentMarket.status);
} else {
  console.log('Nenhum mercado aberto');
}
```

---

## Próximos Passos / TODOs

- [ ] Implementar validação de saldo do usuário
- [ ] Implementar processamento de resultados automático
- [ ] Adicionar endpoint para cancelar apostas (antes do fechamento)
- [ ] Adicionar endpoint para histórico de mercados
- [ ] Implementar paginação nos endpoints de consulta
- [ ] Adicionar filtros avançados (por data, status, etc)
- [ ] Implementar sistema de notificações para resultados
- [ ] Adicionar testes unitários e de integração
