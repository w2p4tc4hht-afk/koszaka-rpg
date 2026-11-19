import 'dotenv/config';
import express from 'express';
import crypto from 'node:crypto';
import pg from 'pg';

const app = express();
app.use(express.json());
app.use(express.static('public'));
const pool = process.env.DATABASE_URL ? new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
}) : null;

function verifyTelegram(initData) {
  if (!process.env.BOT_TOKEN || !initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()].sort(([a],[b])=>a.localeCompare(b))
    .map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = crypto.createHmac('sha256','WebAppData').update(process.env.BOT_TOKEN).digest();
  const calculated = crypto.createHmac('sha256',secret).update(dataCheck).digest('hex');
  const a=Buffer.from(calculated,'hex'), b=Buffer.from(hash,'hex');
  if(a.length!==b.length || !crypto.timingSafeEqual(a,b)) return null;
  const authDate = Number(params.get('auth_date')||0);
  if(Date.now()/1000-authDate > 86400) return null;
  try { return JSON.parse(params.get('user')||'{}'); } catch { return null; }
}
function auth(req,res,next) {
  const user=verifyTelegram(req.get('x-telegram-init-data'));
  if(!user?.id) return res.status(401).json({error:'Открой игру через Telegram.'});
  req.tgUser=user; next();
}
async function ensurePlayer(user) {
  const {rows}=await pool.query(
    `INSERT INTO players(telegram_id,username) VALUES($1,$2)
     ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username,updated_at=NOW()
     RETURNING *`,[String(user.id),user.username||null]);
  return rows[0];
}
app.get('/api/health',(_,res)=>res.json({ok:true,service:'KOSZAKA RPG'}));

const shopItems=[
 {id:'pink_collar',category:'clothes',name:'Розовый ошейник',emoji:'🎀',slot:'accessory',price:60},
 {id:'royal_crown',category:'clothes',name:'Королевская корона',emoji:'👑',slot:'accessory',price:120},
 {id:'star_bow',category:'clothes',name:'Бантик со звездой',emoji:'🌟',slot:'accessory',price:80},
 {id:'heart_glasses',category:'clothes',name:'Очки-сердечки',emoji:'💗',slot:'glasses',price:110},
 {id:'pink_scarf',category:'clothes',name:'Пушистый шарфик',emoji:'🧣',slot:'neck',price:95},
 {id:'angel_wings',category:'clothes',name:'Крылышки',emoji:'🪽',slot:'back',price:180},
 {id:'cozy_bed',category:'room',name:'Пушистая кроватка',emoji:'🛏️',slot:'bed',price:150},
 {id:'pink_rug',category:'room',name:'Розовый ковёр',emoji:'🩷',slot:'rug',price:90},
 {id:'flower_plant',category:'room',name:'Цветок в горшке',emoji:'🌺',slot:'plant',price:70},
 {id:'fish',category:'food',name:'Свежая рыбка',emoji:'🐟',price:12},
 {id:'milk',category:'food',name:'Молочко',emoji:'🥛',price:10},
 {id:'shrimp',category:'food',name:'Креветки',emoji:'🍤',price:18},
 {id:'chicken',category:'food',name:'Куриное филе',emoji:'🍗',price:15},
 {id:'cake',category:'food',name:'Кошачий тортик',emoji:'🍰',price:25},
 {id:'treat',category:'food',name:'Вкусняшка',emoji:'🦴',price:8}
];
app.get('/api/shop',auth,async(req,res)=>{
 if(!pool)return res.status(503).json({error:'База данных недоступна'});
 try{const p=await ensurePlayer(req.tgUser);res.json({items:shopItems,coins:p.coins,inventory:p.inventory||[],equipped:p.equipped||{},foodStock:p.food_stock||{}})}
 catch(e){console.error(e);res.status(500).json({error:'Не удалось загрузить магазин'})}
});
app.post('/api/buy',auth,async(req,res)=>{
 if(!pool)return res.status(503).json({error:'База данных недоступна'});
 const item=shopItems.find(x=>x.id===req.body.itemId);if(!item)return res.status(404).json({error:'Такого предмета нет'});
 const c=await pool.connect();
 try{await c.query('BEGIN');let q=await c.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE',[String(req.tgUser.id)]);
 if(!q.rows.length){await c.query('INSERT INTO players(telegram_id,username) VALUES($1,$2)',[String(req.tgUser.id),req.tgUser.username||null]);q=await c.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE',[String(req.tgUser.id)])}
 const p=q.rows[0],inv=p.inventory||[];if(item.category!=='food' && inv.includes(item.id)){await c.query('ROLLBACK');return res.status(409).json({error:'Этот предмет уже куплен'})}
 if(p.coins<item.price){await c.query('ROLLBACK');return res.status(400).json({error:'Не хватает монет'})}
 let updated;
 if(item.category==='food'){
  updated=await c.query("UPDATE players SET coins=coins-$2,food_stock=jsonb_set(COALESCE(food_stock,'{}'::jsonb),ARRAY[$3],to_jsonb(COALESCE((food_stock->>$3)::int,0)+1),true),updated_at=NOW() WHERE telegram_id=$1 RETURNING *",[String(req.tgUser.id),item.price,item.id]);
 } else {
  updated=await c.query("UPDATE players SET coins=coins-$2,inventory=COALESCE(inventory,'[]'::jsonb)||$3::jsonb,updated_at=NOW() WHERE telegram_id=$1 RETURNING *",[String(req.tgUser.id),item.price,JSON.stringify([item.id])]);
 }
 await c.query('COMMIT');res.json({coins:updated.rows[0].coins,inventory:updated.rows[0].inventory,equipped:updated.rows[0].equipped||{},foodStock:updated.rows[0].food_stock||{}});
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'Покупка не прошла'})}finally{c.release()}
});
app.post('/api/equip',auth,async(req,res)=>{
 if(!pool)return res.status(503).json({error:'База данных недоступна'});
 const item=shopItems.find(x=>x.id===req.body.itemId);if(!item||item.category==='food')return res.status(404).json({error:'Предмет нельзя надеть'});
 try{const p=await ensurePlayer(req.tgUser);if(!(p.inventory||[]).includes(item.id))return res.status(403).json({error:'Сначала купи предмет'});
 const equipped={...(p.equipped||{}),[item.slot]:item.id};
 const q=await pool.query('UPDATE players SET equipped=$2::jsonb,updated_at=NOW() WHERE telegram_id=$1 RETURNING coins,inventory,equipped',[String(req.tgUser.id),JSON.stringify(equipped)]);
 res.json(q.rows[0])}catch(e){console.error(e);res.status(500).json({error:'Не удалось надеть предмет'})}
});

app.post('/api/feed',auth,async(req,res)=>{
 if(!pool)return res.status(503).json({error:'База данных недоступна'});
 const food=shopItems.find(x=>x.id===req.body.foodId&&x.category==='food');
 if(!food)return res.status(400).json({error:'Выбери еду из магазина'});
 const c=await pool.connect();
 try{
  await c.query('BEGIN');
  const q=await c.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE',[String(req.tgUser.id)]);
  if(!q.rows.length){await c.query('ROLLBACK');return res.status(404).json({error:'Профиль не найден'})}
  const p=q.rows[0],stock=p.food_stock||{};
  if((stock[food.id]||0)<1){await c.query('ROLLBACK');return res.status(400).json({error:'Эта еда закончилась. Загляни в магазин еды.'})}
  const hunger=Math.min(100,p.hunger+({fish:24,milk:16,shrimp:30,chicken:28,cake:20,treat:12}[food.id]||20));
  const updated=await c.query("UPDATE players SET hunger=$2,happiness=LEAST(100,happiness+5),food_stock=jsonb_set(COALESCE(food_stock,'{}'::jsonb),ARRAY[$3],to_jsonb(GREATEST(0,COALESCE((food_stock->>$3)::int,0)-1)),true),xp=xp+5,updated_at=NOW() WHERE telegram_id=$1 RETURNING *",[String(req.tgUser.id),hunger,food.id]);
  await c.query('COMMIT');res.json(updated.rows[0]);
 }catch(e){await c.query('ROLLBACK');console.error(e);res.status(500).json({error:'Не удалось покормить котика'})}finally{c.release()}
});
app.get('/api/me',auth,async(req,res)=>{
  if(!pool) return res.status(503).json({error:'DATABASE_URL ещё не настроен.'});
  try { res.json(await ensurePlayer(req.tgUser)); } catch(e){console.error(e);res.status(500).json({error:'Ошибка базы данных'});}
});
const rules={
  feed:{cost:10,delta:{hunger:25,happiness:5},xp:5},
  play:{delta:{energy:-15,happiness:20,hunger:-8},xp:15},
  bath:{delta:{cleanliness:30,happiness:-2},xp:5},
  sleep:{set:{energy:100},xp:0},
  pet:{delta:{happiness:15},xp:3},
  quest:{delta:{energy:-15},coins:25,xp:20}
};
app.post('/api/action',auth,async(req,res)=>{
  if(!pool) return res.status(503).json({error:'DATABASE_URL ещё не настроен.'});
  const rule=rules[req.body.action];
  if(!rule) return res.status(400).json({error:'Неизвестное действие'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    let {rows}=await client.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE',[String(req.tgUser.id)]);
    if(!rows.length) {
      await client.query('INSERT INTO players(telegram_id,username) VALUES($1,$2)',[String(req.tgUser.id),req.tgUser.username||null]);
      ({rows}=await client.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE',[String(req.tgUser.id)]));
    }
    const p=rows[0];
    if(rule.cost && p.coins<rule.cost) { await client.query('ROLLBACK'); return res.status(400).json({error:'Не хватает монет.'}); }
    if(req.body.action==='quest' && p.energy<15) { await client.query('ROLLBACK'); return res.status(400).json({error:'Кот устал. Пусть поспит.'}); }
    const fields=['hunger','energy','cleanliness','happiness'];
    const values={};
    for(const f of fields) values[f]=Math.max(0,Math.min(100,rule.set?.[f]??(p[f]+(rule.delta?.[f]||0))));
    let xp=p.xp+(rule.xp||0), level=p.level, coins=p.coins-(rule.cost||0)+(rule.coins||0);
    if(xp>=100){xp-=100;level++;coins+=50;}
    const updated=await client.query(
      `UPDATE players SET hunger=$2,energy=$3,cleanliness=$4,happiness=$5,xp=$6,level=$7,coins=$8,updated_at=NOW()
       WHERE telegram_id=$1 RETURNING *`,
      [String(req.tgUser.id),values.hunger,values.energy,values.cleanliness,values.happiness,xp,level,coins]);
    await client.query('INSERT INTO actions(telegram_id,action) VALUES($1,$2)',[String(req.tgUser.id),req.body.action]);
    await client.query('COMMIT'); res.json(updated.rows[0]);
  } catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Не удалось выполнить действие'});}
  finally{client.release();}
});
app.post('/api/daily',auth,async(req,res)=>{
  if(!pool) return res.status(503).json({error:'DATABASE_URL ещё не настроен.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    let {rows}=await client.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE',[String(req.tgUser.id)]);
    if(!rows.length) {
      await client.query('INSERT INTO players(telegram_id,username) VALUES($1,$2)',[String(req.tgUser.id),req.tgUser.username||null]);
      ({rows}=await client.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE',[String(req.tgUser.id)]));
    }
    const p=rows[0];
    const today=new Date().toISOString().slice(0,10);
    if(p.last_daily_reward && new Date(p.last_daily_reward).toISOString().slice(0,10)===today) {
      await client.query('ROLLBACK');
      return res.status(409).json({error:'Награда уже получена. Возвращайся завтра!'});
    }
    const updated=await client.query(
      `UPDATE players SET coins=coins+50+CASE WHEN xp+15>=100 THEN 50 ELSE 0 END,xp=CASE WHEN xp+15>=100 THEN xp+15-100 ELSE xp+15 END,level=level+CASE WHEN xp+15>=100 THEN 1 ELSE 0 END,last_daily_reward=CURRENT_DATE,updated_at=NOW()
       WHERE telegram_id=$1 RETURNING *`,[String(req.tgUser.id)]);
    await client.query('COMMIT');
    res.json(updated.rows[0]);
  } catch(e) {
    await client.query('ROLLBACK'); console.error(e);
    res.status(500).json({error:'Не удалось получить награду'});
  } finally { client.release(); }
});
app.post('/api/stars/invoice',auth,async(req,res)=>{
  res.status(501).json({error:'Платежи Stars подключаются после настройки BOT_TOKEN и Telegram webhook.'});
});
async function configureTelegramMenu() {
  if (!process.env.BOT_TOKEN) {
    console.warn('BOT_TOKEN is not configured; Telegram menu button was not set');
    return;
  }
  const url = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || 'https://koszaka-rpg.onrender.com';
  try {
    const response = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/setChatMenuButton`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        menu_button: {
          type: 'web_app',
          text: 'Играть',
          web_app: { url }
        }
      })
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.description || 'Telegram API error');
    console.log('Telegram game menu button is ready');
  } catch (error) {
    console.error('Telegram menu setup failed:', error.message);
  }
}
const port=process.env.PORT||3000;
async function start() {
  if (pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS players (
      telegram_id BIGINT PRIMARY KEY,
      username TEXT,
      pet_name TEXT NOT NULL DEFAULT 'Косик',
      level INTEGER NOT NULL DEFAULT 1,
      xp INTEGER NOT NULL DEFAULT 0,
      coins INTEGER NOT NULL DEFAULT 120,
      hunger INTEGER NOT NULL DEFAULT 80,
      energy INTEGER NOT NULL DEFAULT 80,
      cleanliness INTEGER NOT NULL DEFAULT 80,
      happiness INTEGER NOT NULL DEFAULT 80,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('ALTER TABLE players ADD COLUMN IF NOT EXISTS last_daily_reward DATE');
    await pool.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS inventory JSONB NOT NULL DEFAULT '[]'::jsonb");
    await pool.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS equipped JSONB NOT NULL DEFAULT '{}'::jsonb");
    await pool.query("ALTER TABLE players ADD COLUMN IF NOT EXISTS food_stock JSONB NOT NULL DEFAULT '{}'::jsonb");
    await pool.query(`CREATE TABLE IF NOT EXISTS actions (
      id BIGSERIAL PRIMARY KEY,
      telegram_id BIGINT NOT NULL REFERENCES players(telegram_id),
      action TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    console.log('Database schema is ready');
  } else {
    console.warn('DATABASE_URL is not configured; game API is in setup mode');
  }
  await configureTelegramMenu();
  app.listen(port,()=>console.log(`KOSZAKA RPG listening on ${port}`));
}
start().catch(error=>{console.error('Startup failed:',error);process.exit(1);});
