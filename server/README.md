# AttentionX Backend Server

Бекенд сервер для турнірної системи з підрахунком очок на основі Twitter активності стартапів.

## Архітектура

```
server/
├── db/                     # База даних
│   ├── schema.sql          # SQL схема
│   ├── init.js             # Ініціалізація БД
│   ├── database.js         # ORM функції
│   └── attentionx.db        # SQLite база (створюється автоматично)
├── jobs/
│   └── daily-scorer.js     # Щоденний скрипт підрахунку очок
├── index.js                # API сервер
└── package.json
```

## Встановлення

```bash
cd server
npm install
npm run init-db
```

## Використання

### 1. Запуск API сервера

```bash
npm start
```

Сервер запуститься на `http://localhost:3001`

### 2. Щоденний підрахунок очок

```bash
npm run score
```

Цей скрипт потрібно запускати раз на день (через cron або Task Scheduler).

## API Endpoints

### Tournaments

- `GET /api/tournaments/active` - Отримати активний турнір
- `GET /api/tournaments/:id` - Отримати турнір за ID

### Leaderboard

- `GET /api/leaderboard/:tournamentId?limit=100` - Таблиця лідерів
- `GET /api/player/:address/rank/:tournamentId` - Позиція гравця
- `GET /api/player/:address/history/:tournamentId` - Історія очок гравця
- `GET /api/player/:address/cards/:tournamentId` - Карти гравця в турнірі

### Statistics

- `GET /api/stats/:tournamentId` - Статистика турніру
- `GET /api/daily-scores/:tournamentId/:date` - Очки стартапів за день

## Як працює підрахунок очок

### 1. Фетч даних з blockchain

- Отримує активний турнір з `TournamentManager`
- Отримує список учасників турніру
- Для кожного учасника отримує заблоковані NFT карти

### 2. Фетч даних з Twitter

- Для кожного стартапу отримує останні 3 твіти
- Аналізує твіти за ключовими словами
- Розраховує базові очки за події (funding, partnerships, launches, etc.)

### 3. Розрахунок очок з множниками

Базові очки множаться на рідкість карти:

| Рідкість | Множник |
|----------|---------|
| Common | 1x |
| Rare | 2x |
| Epic | 3x |
| Epic Rare | 4x |
| Legendary | 5x |

**Приклад:**
- Стартап отримав 500 базових очок за день
- У гравця є Epic карта цього стартапу (3x)
- Гравець отримує: 500 × 3 = **1,500 очок**

### 4. Оновлення leaderboard

- Зберігає щоденні очки в історію
- Підраховує загальний рахунок
- Оновлює позицію в таблиці лідерів

## База даних

SQLite база з наступними таблицями:

- `tournaments` - Інформація про турніри
- `players` - Гравці
- `tournament_entries` - Реєстрації на турніри
- `tournament_cards` - Заблоковані карти учасників
- `daily_scores` - Щоденні очки стартапів
- `leaderboard` - Таблиця лідерів
- `score_history` - Історія нарахування очок

## Налаштування cron (автоматичний запуск)

### Linux/Mac

```bash
crontab -e
```

Додати:
```
0 2 * * * cd /path/to/server && npm run score >> /var/log/attentionx-scorer.log 2>&1
```

### Windows (Task Scheduler)

1. Відкрити Task Scheduler
2. Create Basic Task
3. Trigger: Daily at 2:00 AM
4. Action: Start a program
   - Program: `node`
   - Arguments: `jobs/daily-scorer.js`
   - Start in: `C:\path\to\server`

## Конфігурація

Змінити у `jobs/daily-scorer.js`:

```javascript
const RPC_URL = 'http://127.0.0.1:8545'; // Your RPC endpoint
const TOURNAMENT_ADDRESS = '0x...'; // Your contract address
const NFT_ADDRESS = '0x...'; // Your NFT contract address
```

## Troubleshooting

### База даних не знайдена

```bash
npm run init-db
```

### API не відповідає

Перевірити чи запущений сервер:
```bash
curl http://localhost:3001/health
```

### Twitter API rate limit

Скрипт автоматично чекає 5 секунд між запитами. Для 19 стартапів загальний час: ~95 секунд.
