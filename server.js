import express from "express";
import multer from "multer";
import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new Database(path.join(DATA_DIR, "warehouse.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS items(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 barcode TEXT UNIQUE NOT NULL,
 cuval TEXT DEFAULT '',
 fis TEXT DEFAULT '',
 date TEXT DEFAULT '',
 code TEXT DEFAULT '',
 name TEXT DEFAULT '',
 sender TEXT DEFAULT '',
 customer TEXT DEFAULT '',
 kg TEXT DEFAULT '',
 warehouse TEXT DEFAULT '',
 status TEXT NOT NULL DEFAULT 'В наличии',
 added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 issued_at TEXT DEFAULT '',
 received_at TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS history(
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 action TEXT NOT NULL,
 barcode TEXT NOT NULL,
 cuval TEXT DEFAULT '',
 warehouse TEXT DEFAULT '',
 time TEXT NOT NULL
);
`);
function addColumn(sql) { try { db.exec(sql); } catch {} }
addColumn("ALTER TABLE items ADD COLUMN received_at TEXT DEFAULT ''");
addColumn("ALTER TABLE items ADD COLUMN sender TEXT DEFAULT ''");
addColumn("ALTER TABLE items ADD COLUMN customer TEXT DEFAULT ''");

app.use(express.json({limit:"10mb"}));
app.use(express.urlencoded({extended:true}));
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"index.html")));

const upload = multer({storage: multer.memoryStorage()});
function clean(s) { return String(s ?? "").replace(/^\uFEFF/,"").trim(); }
function key(s) { return clean(s).replace(/[\s\u00A0]/g,""); }
function normHeader(s) { return clean(s).toLowerCase().replace(/[.:]/g,"").replace(/\s+/g," "); }
function isAnyHeader(s) {
 const n=normHeader(s);
 return ["fiş no","barkod","malzeme","gönderen","müşteri kodu","müşteri","ağırlık"].some(x=>n===x);
}
function parseKargoFields(fields) {
 const f=fields.map(clean);
 if(f.length<6) return null;
 if(!/^\d+$/.test(f[0]) || !/^\d+$/.test(f[1])) return null;
 if(!/^\d+(?:[.,]\d+)?$/.test(f[f.length-1])) return null;
 return {
  fis:f[0], barcode:key(f[1]), material:f[2]||"", sender:f[3]||"",
  cuval:key(f[4]||""), customer:f.length>=7?(f[5]||""):"",
  kg:f[f.length-1]||""
 };
}
function parseText(text) {
 const rawLines=String(text||"").replace(/\r/g,"").split("\n").map(x=>x.replace(/^\uFEFF/,""));
 const lines=rawLines.map(clean), out=[];
 for(const raw of lines){
  if(!raw||isAnyHeader(raw)) continue;
  const parts=raw.split(/\t|\s*\|\s*|\s*;\s*/).map(clean);
  if(parts.length>=6){
   const x=parseKargoFields(parts);
   if(x&&x.barcode&&x.fis) out.push(x);
  }
 }
 if(out.length) return out;
 const useful=lines.filter(Boolean).filter(x=>!isAnyHeader(x));
 for(let i=0;i<useful.length;i++){
  if(!/^\d+$/.test(useful[i])) continue;
  if(useful[i+1]==="#"||useful[i+1]==="№") continue;
  if(i+6<useful.length && /^\d+$/.test(useful[i+1]) && /^\d+$/.test(useful[i+2]) &&
     /^\d+(?:[.,]\d+)?$/.test(useful[i+6])){
   const x=parseKargoFields(useful.slice(i+1,i+7));
   if(x&&x.barcode&&x.fis){out.push(x);i+=6;}
  }
 }
 if(!out.length){
  for(const line of useful) if(/^\d{4,}$/.test(line))
   out.push({fis:"",barcode:key(line),material:"",sender:"",cuval:"",customer:"",kg:""});
 }
 return out;
}
function now(){return new Date().toLocaleString("ru-RU",{dateStyle:"short",timeStyle:"medium"});}

app.get("/api/search",(req,res)=>{
 const type=["cuval","barcode","fis"].includes(req.query.type)?req.query.type:"cuval";
 const value=key(req.query.value);
 if(!value) return res.json([]);
 // Numeric identifiers are normalized on both sides, so pasted/scanned spaces do not break lookup.
 const rows=db.prepare(`SELECT * FROM items WHERE REPLACE(REPLACE(TRIM(CAST(${type} AS TEXT)),' ',''),char(160),'')=? ORDER BY id DESC`).all(value);
 res.json(rows);
});

app.get("/api/history",(req,res)=>res.json(db.prepare("SELECT * FROM history ORDER BY id DESC LIMIT 300").all()));

app.post("/api/operation",upload.single("file"),(req,res)=>{
 const action=req.body.action, warehouse=req.body.warehouse||"";
 const text=req.body.text||(req.file?req.file.buffer.toString("utf8"):"");
 if(!text.trim()) return res.status(400).json({error:"Нет данных для обработки."});
 if(!["add","remove"].includes(action)) return res.status(400).json({error:"Неизвестное действие."});
 if(action==="add"&&!["Склад 1","Склад 2","Склад 3"].includes(warehouse))
  return res.status(400).json({error:"Выберите склад."});
 const items=parseText(text);
 if(!items.length) return res.status(400).json({error:"Не удалось распознать данные KargoSis."});
 let added=0,removed=0,duplicates=0,notFound=0;
 const hist=db.prepare("INSERT INTO history(action,barcode,cuval,warehouse,time) VALUES(?,?,?,?,?)");
 const insert=db.prepare(`INSERT INTO items(barcode,cuval,fis,date,code,name,sender,customer,kg,warehouse,status,added_at,received_at)
 VALUES(@barcode,@cuval,@fis,'','',@material,@sender,@customer,@kg,@warehouse,'В наличии',@received_at,@received_at)`);
 const updateOld=db.prepare(`UPDATE items SET cuval=?,fis=?,name=?,sender=?,customer=?,kg=?,warehouse=?,status='В наличии',issued_at='',added_at=?,received_at=? WHERE id=?`);
 const issue=db.prepare("UPDATE items SET status='Выдан',issued_at=? WHERE id=?");
 const tx=db.transaction(()=>{
  for(const x of items){
   if(action==="add"){
    const existing=db.prepare("SELECT * FROM items WHERE REPLACE(REPLACE(TRIM(CAST(barcode AS TEXT)),' ',''),char(160),'')=?").get(key(x.barcode));
    const received=now();
    if(existing&&existing.status==="В наличии"){duplicates++;continue;}
    if(existing) updateOld.run(x.cuval,x.fis,x.material,x.sender,x.customer,x.kg,warehouse,received,received,existing.id);
    else insert.run({...x,warehouse,received_at:received});
    hist.run("Добавлен",x.barcode,x.cuval,warehouse,received); added++;
   }else{
    const row=db.prepare("SELECT * FROM items WHERE REPLACE(REPLACE(TRIM(CAST(barcode AS TEXT)),' ',''),char(160),'')=? AND status='В наличии'").get(key(x.barcode));
    if(!row){notFound++;continue;}
    const t=now(); issue.run(t,row.id); hist.run("Выдан",row.barcode,row.cuval,row.warehouse,t); removed++;
   }
  }
 });
 tx();
 res.json({added,removed,duplicates,notFound,total:items.length,parsed:items.length});
});

app.post("/api/issue",(req,res)=>{
 const barcode=key(req.body?.barcode);
 if(!barcode) return res.status(400).json({error:"Не указан баркод."});
 const row=db.prepare("SELECT * FROM items WHERE REPLACE(REPLACE(TRIM(CAST(barcode AS TEXT)),' ',''),char(160),'')=? AND status='В наличии'").get(barcode);
 if(!row){
  const existing=db.prepare("SELECT * FROM items WHERE REPLACE(REPLACE(TRIM(CAST(barcode AS TEXT)),' ',''),char(160),'')=?").get(barcode);
  if(existing&&existing.status==="Выдан") return res.status(409).json({error:"Этот мешок уже выдан."});
  return res.status(404).json({error:"Мешок с таким баркодом не найден."});
 }
 const t=now();
 db.prepare("UPDATE items SET status='Выдан',issued_at=? WHERE id=?").run(t,row.id);
 db.prepare("INSERT INTO history(action,barcode,cuval,warehouse,time) VALUES(?,?,?,?,?)").run("Выдан",row.barcode,row.cuval,row.warehouse,t);
 const item=db.prepare("SELECT * FROM items WHERE id=?").get(row.id);
 res.json({item});
});

app.get("/api/export",(req,res)=>{
 const rows=db.prepare("SELECT barcode,cuval,fis,name,sender,customer,kg,received_at,warehouse,status FROM items ORDER BY id").all();
 const esc=v=>`"${String(v??"").replaceAll('"','""')}"`;
 const csv="\ufeffБаркод,Номер клиента (Чувал №),Фиш №,Товар,Отправитель,Клиент,KG,Получен,Склад,Статус\n"+
 rows.map(r=>[r.barcode,r.cuval,r.fis,r.name,r.sender,r.customer,r.kg,r.received_at,r.warehouse,r.status].map(esc).join(",")).join("\n");
 res.setHeader("Content-Type","text/csv; charset=utf-8");
 res.setHeader("Content-Disposition",'attachment; filename="склад_база.csv"');
 res.send(csv);
});
app.listen(PORT,()=>console.log(`Warehouse site: http://localhost:${PORT}`));
