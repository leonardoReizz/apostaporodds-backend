// Script de exemplo para testar o envio de jogos e abertura de mercado
// Execute: node test-game.js

const games = [
  {
    id: "game1",
    teamA: "São Paulo",
    teamB: "Corinthians",
    odds: 2.50
  },
  {
    id: "game2",
    teamA: "Flamengo",
    teamB: "Palmeiras",
    odds: 1.80
  }
];

async function sendGame(game) {
  try {
    const response = await fetch('http://localhost:3000/api/games', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(game),
    });
    
    const data = await response.json();
    console.log(`✅ Jogo enviado: ${game.teamA} vs ${game.teamB}`, data);
    return data;
  } catch (error) {
    console.error('❌ Erro ao enviar jogo:', error.message);
    throw error;
  }
}

async function openMarket() {
  try {
    const response = await fetch('http://localhost:3000/api/market/open', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    
    const data = await response.json();
    console.log(`✅ Mercado aberto!`, data);
    return data;
  } catch (error) {
    console.error('❌ Erro ao abrir mercado:', error.message);
    throw error;
  }
}

async function testGames() {
  console.log('🚀 Iniciando teste de envio de jogos e abertura de mercado...\n');
  
  console.log('📝 Passo 1: Adicionando primeiro jogo...');
  await sendGame(games[0]);
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log('\n📝 Passo 2: Adicionando segundo jogo...');
  await sendGame(games[1]);
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  console.log('\n⏰ Passo 3: Abrindo mercado (timer iniciará)...');
  await openMarket();
  
  console.log('\n✨ Teste concluído! O timer de 15 segundos deve estar rodando no frontend.');
}

testGames();

