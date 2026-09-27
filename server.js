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
  kg TEXT DEFAULT '',
  warehouse TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'В наличии',
  added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  issued_at TEXT DEFAULT ''
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

app.use(express.json({limit:"10mb"}));
app.use(express.urlencoded({extended:true}));
app.get("/", (req,res)=>res.sendFile(path.join(__dirname,"index.html")));

const upload = multer({storage: multer.memoryStorage()});

function parseText(text){
  const out=[];
  for(const raw of String(text||"").split(/\r?\n/)){
    const line=raw.trim();
    if(!line) continue;
    if(/^(barcode|баркод|barkod)$/i.test(line)) continue;
    let p=line.split(/\s*[|;\t]\s*/);
    if(p.length<2) p=line.split(/\s*,\s*/);
    if(p.length===1){
      out.push({barcode:p[0].trim(),cuval:"",fis:"",date:"",code:"",name:"",kg:""});
    }else{
      out.push({
        barcode:(p[0]||"").trim(),
        cuval:(p[1]||"").trim(),
        fis:(p[2]||"").trim(),
        date:(p[3]||"").trim(),
        code:(p[4]||"").trim(),
        name:(p[5]||"").trim(),
        kg:(p[6]||"").trim()
      });
    }
  }
  return out.filter(x=>x.barcode);
}

function now(){
  return new Date().toLocaleString("ru-RU",{dateStyle:"short",timeStyle:"medium"});
}

app.get("/api/search", (req,res)=>{
  const type = ["cuval","barcode","fis"].includes(req.query.type) ? req.query.type : "cuval";
  const value = String(req.query.value||"").trim();
  if(!value) return res.json([]);
  const rows = db.prepare(`SELECT * FROM items WHERE ${type}=? ORDER BY id DESC`).all(value);
  res.json(rows);
});

app.get("/api/history",(req,res)=>{
  res.json(db.prepare("SELECT * FROM history ORDER BY id DESC LIMIT 300").all());
});

app.post("/api/operation", upload.single("file"), (req,res)=>{
  const action = req.body.action;
  const warehouse = req.body.warehouse || "";
  const text = req.body.text || (req.file ? req.file.buffer.toString("utf8") : "");
  if(!text.trim()) return res.status(400).json({error:"Нет данных для обработки."});
  if(!["add","remove"].includes(action)) return res.status(400).json({error:"Неизвестное действие."});
  if(action==="add" && !["Склад 1","Склад 2","Склад 3"].includes(warehouse))
    return res.status(400).json({error:"Выберите склад."});

  const items=parseText(text);
  let added=0, removed=0, duplicates=0, notFound=0;
  const insert=db.prepare(`INSERT INTO items(barcode,cuval,fis,date,code,name,kg,warehouse,status)
    VALUES(@barcode,@cuval,@fis,@date,@code,@name,@kg,@warehouse,'В наличии')`);
  const hist=db.prepare(`INSERT INTO history(action,barcode,cuval,warehouse,time) VALUES(?,?,?,?,?)`);
  const update=db.prepare(`UPDATE items SET status='Выдан',issued_at=? WHERE id=?`);
  const tx=db.transaction(()=>{
    for(const x of items){
      if(action==="add"){
        const existing=db.prepare("SELECT * FROM items WHERE barcode=?").get(x.barcode);
        if(existing && existing.status==="В наличии"){duplicates++; continue;}
        if(existing && existing.status==="Выдан"){
          // Re-use the barcode as a new stock entry while keeping old history.
          db.prepare(`UPDATE items SET cuval=?,fis=?,date=?,code=?,name=?,kg=?,warehouse=?,status='В наличии',issued_at='' WHERE id=?`)
            .run(x.cuval,x.fis,x.date,x.code,x.name,x.kg,warehouse,existing.id);
        }else{
          insert.run({...x,warehouse});
        }
        hist.run("Добавлен",x.barcode,x.cuval,warehouse,now());
        added++;
      }else{
        const row=db.prepare("SELECT * FROM items WHERE barcode=? AND status='В наличии'").get(x.barcode);
        if(!row){notFound++; continue;}
        update.run(now(),row.id);
        hist.run("Выдан",row.barcode,row.cuval,row.warehouse,now());
        removed++;
      }
    }
  });
  tx();
  res.json({added,removed,duplicates,notFound,total:items.length});
});

app.get("/api/export",(req,res)=>{
  const rows=db.prepare("SELECT barcode,cuval,fis,date,code,name,kg,warehouse,status FROM items ORDER BY id").all();
  const esc=v=>`"${String(v??"").replaceAll('"','""')}"`;
  const csv="\ufeffБаркод,Чувал №,Фиш №,Дата,Код,Имя,KG,Склад,Статус\n"+
    rows.map(r=>[r.barcode,r.cuval,r.fis,r.date,r.code,r.name,r.kg,r.warehouse,r.status].map(esc).join(",")).join("\n");
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",'attachment; filename="склад_база.csv"');
  res.send(csv);
});

app.listen(PORT,()=>console.log(`Warehouse site: http://localhost:${PORT}`));
