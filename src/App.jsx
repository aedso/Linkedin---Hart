import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import * as XLSX from "xlsx";
import {
  LineChart, Line, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

// ── Supabase config from Vercel env vars ─────────────────────────────────────
const SUPA_URL = (import.meta.env.VITE_SUPABASE_URL || "").trim().replace(/\/$/, "");
const SUPA_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || "").trim();
const ENV_OK = SUPA_URL.startsWith("https://") && SUPA_KEY.startsWith("eyJ");

// ── Colors ───────────────────────────────────────────────────────────────────
const COLORS = ["#0077B5", "#F59E0B", "#10B981", "#EF4444", "#8B5CF6"];

// ── Date helpers ─────────────────────────────────────────────────────────────
function toIso(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().split("T")[0];
  const s = String(v);
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return null;
}
const fmtNum = (n) =>
  !n ? "0" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "K" : String(n);
const fmtDate = (iso) => (iso ? iso.split("-").reverse().join("/") : "");
const fmtMonth = (iso) => {
  if (!iso) return "";
  const PT = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];
  const [y, mo] = iso.split("-");
  return `${PT[+mo - 1]}/${y.slice(2)}`;
};
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// ── XLSX parsers ─────────────────────────────────────────────────────────────
function parseDiscovery(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  let impressions = 0, membersReached = 0;
  for (const r of rows) {
    if (String(r[0] || "").includes("Impressions")) impressions = +r[1] || 0;
    if (String(r[0] || "").includes("Members")) membersReached = +r[1] || 0;
  }
  return { impressions, membersReached };
}
function parseEngagement(ws) {
  return XLSX.utils.sheet_to_json(ws, { header: 1 })
    .slice(1)
    .map((r) => { const d = toIso(r[0]); return d ? { date: d, impressions: +r[1] || 0, engagements: +r[2] || 0 } : null; })
    .filter(Boolean);
}
function parseTopPosts(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const isUrl = (v) => typeof v === "string" && v.includes("linkedin.com/feed");
  const map = {};
  for (const r of rows) {
    if (isUrl(r[0])) { const u = r[0]; map[u] = { ...(map[u] || {}), url: u, date: toIso(r[1]) || String(r[1] || ""), engagements: +r[2] || 0 }; }
    if (isUrl(r[4])) { const u = r[4]; map[u] = { ...(map[u] || {}), url: u, date: toIso(r[5]) || String(r[5] || ""), impressions: +r[6] || 0 }; }
  }
  return Object.values(map);
}
function parseFollowers(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  let total = 0; const daily = [];
  for (const r of rows) {
    if (typeof r[0] === "string" && r[0].includes("Total followers")) total = +r[1] || 0;
    const d = toIso(r[0]); if (d) daily.push({ date: d, new_followers: +r[1] || 0 });
  }
  return { total, daily };
}
function parseDemographics(ws) {
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
  const MAP = { "Job titles": "jobTitles", "Locations": "locations", "Industries": "industries", "Seniority": "seniority", "Company size": "companySize", "Companies": "companies" };
  const items = []; let cur = null;
  for (const r of rows) {
    const cat = MAP[String(r[0] || "")];
    if (cat) { cur = cat; if (r[1]) items.push({ category: cur, value: String(r[1]), percentage: typeof r[2] === "number" ? r[2] : 0 }); }
    else if (cur && r[1]) items.push({ category: cur, value: String(r[1]), percentage: typeof r[2] === "number" ? r[2] : 0 });
  }
  return items;
}
function detectName(fn) {
  const p = fn.replace(/\.(xlsx|xls|csv)$/i, "").split("_");
  return p[0] === "Content" && p.length > 3 ? p.slice(3).join(" ") : fn.replace(/\.(xlsx|xls|csv)$/i, "");
}
function parseWorkbook(buf, filename) {
  const wb = XLSX.read(buf, { type: "array", cellDates: true });
  const s = (n) => (wb.SheetNames.includes(n) ? wb.Sheets[n] : null);
  const fol = s("FOLLOWERS") ? parseFollowers(s("FOLLOWERS")) : { total: 0, daily: [] };
  return {
    name: detectName(filename), filename,
    discovery: s("DISCOVERY") ? parseDiscovery(s("DISCOVERY")) : { impressions: 0, membersReached: 0 },
    engagement: s("ENGAGEMENT") ? parseEngagement(s("ENGAGEMENT")) : [],
    posts: s("TOP POSTS") ? parseTopPosts(s("TOP POSTS")) : [],
    followers: fol,
    demographics: s("DEMOGRAPHICS") ? parseDemographics(s("DEMOGRAPHICS")) : [],
  };
}

// ── Supabase REST client ──────────────────────────────────────────────────────
function buildClient(token) {
  const authKey = token || SUPA_KEY;
  const hdrs = { "apikey": SUPA_KEY, "Authorization": `Bearer ${authKey}`, "Content-Type": "application/json" };
  const req = async (path, opts = {}) => {
    const res = await fetch(`${SUPA_URL}${path}`, { ...opts, headers: { ...hdrs, ...(opts.headers || {}) } });
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (!res.ok) throw new Error(typeof data === "object" ? (data.message || data.msg || JSON.stringify(data)) : String(text));
    return data;
  };
  return {
    auth: {
      signIn: (email, pw) =>
        fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
          method: "POST",
          headers: { "apikey": SUPA_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ email, password: pw }),
        }).then((r) => r.json()),
      signOut: () =>
        fetch(`${SUPA_URL}/auth/v1/logout`, {
          method: "POST",
          headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${token}` },
        }).catch(() => {}),
      updatePassword: (newPassword) =>
        fetch(`${SUPA_URL}/auth/v1/user`, {
          method: "PUT",
          headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ password: newPassword }),
        }).then((r) => r.json()),
    },
    from: (table) => ({
      select: (cols = "*", qs = "") => req(`/rest/v1/${table}?select=${cols}${qs}`),
      upsert: (data, onConflict) =>
        req(`/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ""}`, {
          method: "POST",
          headers: { "Prefer": "resolution=merge-duplicates,return=minimal" },
          body: JSON.stringify(Array.isArray(data) ? data : [data]),
        }),
      insert: (data) =>
        req(`/rest/v1/${table}`, {
          method: "POST",
          headers: { "Prefer": "return=representation" },
          body: JSON.stringify(Array.isArray(data) ? data : [data]),
        }),
    }),
  };
}

// ── Save to Supabase with deduplication ───────────────────────────────────────
async function saveToSupabase(client, parsed, existingProfiles) {
  const today = new Date().toISOString().split("T")[0];

  // 1. Find or create profile
  let profile = existingProfiles.find((p) => p.name.toLowerCase() === parsed.name.toLowerCase());
  if (!profile) {
    const created = await client.from("li_profiles").insert({ name: parsed.name });
    profile = Array.isArray(created) ? created[0] : created;
  }
  const pid = profile.id;

  // 2. Discovery snapshot — dedup on (profile_id, snapshot_date)
  await client.from("li_discovery").upsert({
    profile_id: pid, snapshot_date: today,
    impressions: parsed.discovery.impressions,
    members_reached: parsed.discovery.membersReached,
    total_followers: parsed.followers.total,
  }, "profile_id,snapshot_date");

  // 3. Engagement daily — dedup on (profile_id, date)
  if (parsed.engagement.length) {
    for (const c of chunk(parsed.engagement.map((d) => ({ profile_id: pid, date: d.date, impressions: d.impressions, engagements: d.engagements })), 200))
      await client.from("li_engagement_daily").upsert(c, "profile_id,date");
  }

  // 4. Followers daily — dedup on (profile_id, date)
  if (parsed.followers.daily.length) {
    for (const c of chunk(parsed.followers.daily.map((d) => ({ profile_id: pid, date: d.date, new_followers: d.new_followers })), 200))
      await client.from("li_followers_daily").upsert(c, "profile_id,date");
  }

  // 5. Top posts — dedup on (profile_id, post_url)
  if (parsed.posts.length) {
    await client.from("li_top_posts").upsert(
      parsed.posts.map((p) => ({ profile_id: pid, post_url: p.url, publish_date: p.date || null, engagements: p.engagements || 0, impressions: p.impressions || 0 })),
      "profile_id,post_url"
    );
  }

  // 6. Demographics — dedup on (profile_id, snapshot_date, category, value)
  if (parsed.demographics.length) {
    await client.from("li_demographics").upsert(
      parsed.demographics.map((d) => ({ profile_id: pid, snapshot_date: today, category: d.category, value: d.value, percentage: d.percentage })),
      "profile_id,snapshot_date,category,value"
    );
  }
}

// ── UI primitives ─────────────────────────────────────────────────────────────
const card = { background: "#fff", borderRadius: 12, boxShadow: "0 1px 4px rgba(0,0,0,0.07)" };

const Input = ({ label, type = "text", value, onChange, placeholder, autoFocus, mono }) => (
  <div style={{ marginBottom: 14 }}>
    {label && <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", marginBottom: 5 }}>{label}</div>}
    <input
      type={type} value={value} onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder} autoFocus={autoFocus}
      style={{ width: "100%", padding: "10px 12px", border: "1px solid #E2E8F0", borderRadius: 8, fontSize: mono ? 11 : 14, fontFamily: mono ? "monospace" : "inherit", outline: "none", boxSizing: "border-box", color: "#0F172A" }}
    />
  </div>
);

const Btn = ({ children, onClick, disabled, variant = "primary", full }) => (
  <button onClick={onClick} disabled={disabled} style={{
    padding: "11px 22px", width: full ? "100%" : "auto",
    background: disabled ? "#E2E8F0" : variant === "primary" ? "linear-gradient(90deg,#0077B5,#005885)" : "#F1F5F9",
    color: disabled ? "#94A3B8" : variant === "primary" ? "#fff" : "#334155",
    border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600,
    cursor: disabled ? "not-allowed" : "pointer", transition: "all 0.15s", whiteSpace: "nowrap",
  }}>{children}</button>
);

const StatCard = ({ label, value, sub, accent }) => (
  <div style={{ ...card, padding: "18px 20px", borderLeft: `4px solid ${accent}` }}>
    <div style={{ fontSize: 10, color: "#94A3B8", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 700, color: "#0F172A", lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 11, color: "#CBD5E1", marginTop: 6 }}>{sub}</div>}
  </div>
);

const DemoBar = ({ title, items = [], color }) => {
  const max = Math.max(...items.map((d) => d.pct), 0.001);
  return (
    <div style={{ ...card, padding: 20 }}>
      <div style={{ fontWeight: 600, color: "#0F172A", marginBottom: 14, fontSize: 14 }}>{title}</div>
      {!items.length && <div style={{ color: "#CBD5E1", fontSize: 12 }}>Sem dados</div>}
      {items.slice(0, 6).map((d, i) => (
        <div key={i} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
            <span style={{ fontSize: 12, color: "#475569" }}>{d.label}</span>
            <span style={{ fontSize: 11, color: "#94A3B8", fontWeight: 500 }}>{d.pct > 0 ? (d.pct * 100).toFixed(1) + "%" : "< 1%"}</span>
          </div>
          <div style={{ height: 5, background: "#F1F5F9", borderRadius: 3 }}>
            <div style={{ height: "100%", width: `${d.pct > 0 ? Math.max((d.pct / max) * 100, 2) : 0}%`, background: color, borderRadius: 3, transition: "width 0.5s" }} />
          </div>
        </div>
      ))}
    </div>
  );
};

// ── Tela de login ─────────────────────────────────────────────────────────────
function LoginScreen({ onLogin }) {
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);

  const login = async () => {
    if (!ENV_OK) {
      setErr(`Configuração incompleta. URL: "${SUPA_URL.slice(0,30)||"vazia"}" — verifique as env vars no Vercel e faça Redeploy sem cache.`);
      return;
    }
    setLoading(true); setErr("");
    try {
      const res = await fetch(`${SUPA_URL}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "apikey": SUPA_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: pass }),
      });
      const data = await res.json();
      setLoading(false);
      if (data.access_token) {
        localStorage.setItem("hart_session", JSON.stringify(data));
        onLogin(data);
      } else {
        const msg = data.error_description || data.error || data.msg || JSON.stringify(data);
        setErr("Erro: " + msg);
      }
    } catch (e) {
      setLoading(false);
      setErr("Erro de conexão: " + e.message);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#EFF6FF,#F8FAFC)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui,sans-serif", padding: 24 }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: 40, maxWidth: 380, width: "100%", boxShadow: "0 8px 40px rgba(0,119,181,0.12)" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 52, height: 52, background: "#0077B5", borderRadius: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
            <span style={{ color: "#fff", fontWeight: 800, fontSize: 22 }}>H</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#0F172A", marginBottom: 4 }}>Hart Analytics</div>
          <div style={{ fontSize: 13, color: "#94A3B8" }}>Acesso restrito aos sócios</div>
        </div>
        <div onKeyDown={(e) => { if (e.key === "Enter" && email && pass) login(); }}>
          <Input label="E-mail" type="email" value={email} onChange={setEmail} placeholder="nome@hartliving.com.br" autoFocus />
          <Input label="Senha" type="password" value={pass} onChange={setPass} placeholder="••••••••" />
        </div>
        {err && <div style={{ background: "#FEF2F2", color: "#DC2626", borderRadius: 8, padding: "10px 14px", fontSize: 12, marginBottom: 12 }}>{err}</div>}
        <Btn full onClick={login} disabled={!email || !pass || loading}>{loading ? "Entrando..." : "Entrar →"}</Btn>
        <div style={{ marginTop: 16, textAlign: "center", fontSize: 10, color: ENV_OK ? "#10B981" : "#F59E0B" }}>
          {ENV_OK ? "✓ Supabase configurado" : "⚠ Env vars não detectadas — veja instruções abaixo"}
        </div>
        {!ENV_OK && (
          <div style={{ marginTop: 10, background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", fontSize: 11, color: "#92400E", lineHeight: 1.6 }}>
            <strong>Para corrigir:</strong><br/>
            1. Vercel → Settings → Environment Variables<br/>
            2. Confirme <code>VITE_SUPABASE_URL</code> e <code>VITE_SUPABASE_ANON_KEY</code><br/>
            3. Deployments → ··· → Redeploy → <strong>desmarque "Use existing build cache"</strong>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Upload modal ──────────────────────────────────────────────────────────────
function UploadModal({ client, existingProfiles, onClose, onDone }) {
  const [files, setFiles] = useState([]);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState({});
  const [running, setRunning] = useState(false);
  const inputRef = useRef();

  const addFiles = useCallback((fs) => {
    setFiles((p) => [...p, ...Array.from(fs).map((f) => ({ file: f, name: detectName(f.name) }))]);
  }, []);

  const process = async () => {
    setRunning(true);
    let allProfs = [...existingProfiles];
    for (const item of files) {
      setStatus((s) => ({ ...s, [item.file.name]: "uploading" }));
      try {
        const buf = new Uint8Array(await item.file.arrayBuffer());
        const parsed = parseWorkbook(buf, item.file.name);
        parsed.name = item.name;
        await saveToSupabase(client, parsed, allProfs);
        try { const updated = await client.from("li_profiles").select("*"); if (Array.isArray(updated)) allProfs = updated; } catch {}
        setStatus((s) => ({ ...s, [item.file.name]: "done" }));
      } catch (e) {
        console.error(e);
        setStatus((s) => ({ ...s, [item.file.name]: "error: " + e.message.slice(0, 80) }));
      }
    }
    setRunning(false);
    setTimeout(() => onDone(), 1000);
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 20 }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: 32, maxWidth: 520, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontWeight: 700, color: "#0F172A", fontSize: 16 }}>📤 Upload de Dados LinkedIn</div>
          <button onClick={onClose} disabled={running} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: "#94A3B8", lineHeight: 1 }}>×</button>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          style={{ border: `2px dashed ${dragging ? "#0077B5" : "#CBD5E1"}`, borderRadius: 12, padding: "28px 20px", textAlign: "center", cursor: "pointer", background: dragging ? "#EFF6FF" : "#F8FAFC", marginBottom: 16, transition: "all 0.2s" }}
        >
          <div style={{ fontSize: 32, marginBottom: 6 }}>📂</div>
          <div style={{ fontWeight: 600, color: "#334155", fontSize: 13 }}>Arraste os .xlsx exportados do LinkedIn</div>
          <div style={{ fontSize: 11, color: "#94A3B8", marginTop: 2 }}>ou clique para selecionar • múltiplos arquivos de uma vez</div>
          <input ref={inputRef} type="file" multiple accept=".xlsx,.xls" style={{ display: "none" }} onChange={(e) => addFiles(e.target.files)} />
        </div>

        {files.map((item, i) => {
          const st = status[item.file.name];
          const isErr = st?.startsWith("error"), isDone = st === "done", isUp = st === "uploading";
          return (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "#F8FAFC", borderRadius: 8, marginBottom: 6, border: `1px solid ${isErr ? "#FEE2E2" : isDone ? "#DCFCE7" : "#F1F5F9"}` }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: COLORS[i % COLORS.length], flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <input value={item.name} disabled={running} onChange={(e) => setFiles((f) => f.map((x, j) => j === i ? { ...x, name: e.target.value } : x))}
                  style={{ border: "none", background: "none", fontSize: 13, fontWeight: 600, color: "#334155", outline: "none", width: "100%" }} />
                <div style={{ fontSize: 10, color: "#94A3B8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.file.name}</div>
              </div>
              <div style={{ fontSize: 11, fontWeight: 500, flexShrink: 0, color: isDone ? "#16A34A" : isUp ? "#0077B5" : isErr ? "#DC2626" : "#94A3B8" }}>
                {isDone ? "✓ Salvo" : isUp ? "⏳..." : isErr ? "✗ Erro" : "—"}
              </div>
              {!running && !st && <button onClick={() => setFiles((f) => f.filter((_, j) => j !== i))} style={{ background: "none", border: "none", cursor: "pointer", color: "#CBD5E1", fontSize: 18, lineHeight: 1, flexShrink: 0 }}>×</button>}
            </div>
          );
        })}

        {files.length > 0 && (
          <div style={{ margin: "10px 0 18px", background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "8px 14px", fontSize: 11, color: "#166534", display: "flex", gap: 6 }}>
            <span>✓</span><span>Upload seguro — dados duplicados são atualizados automaticamente, nunca duplicados.</span>
          </div>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <Btn onClick={process} disabled={!files.length || running}>{running ? "Salvando..." : `Salvar ${files.length} arquivo${files.length !== 1 ? "s" : ""} →`}</Btn>
          <Btn variant="secondary" onClick={onClose} disabled={running}>Cancelar</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ session, onLogout }) {
  const client = useMemo(() => buildClient(session.access_token), [session]);
  const [profiles, setProfiles] = useState([]);
  const [dbData, setDbData] = useState({ eng: [], fol: [], posts: [], disc: [], demo: [] });
  const [sel, setSel] = useState("all");
  const [tab, setTab] = useState("overview");
  const [showUpload, setShowUpload] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [profs, eng, fol, posts, disc, demo] = await Promise.all([
        client.from("li_profiles").select("*"),
        client.from("li_engagement_daily").select("*"),
        client.from("li_followers_daily").select("*"),
        client.from("li_top_posts").select("*"),
        client.from("li_discovery").select("*"),
        client.from("li_demographics").select("*"),
      ]);
      setProfiles(Array.isArray(profs) ? profs : []);
      setDbData({ eng: eng || [], fol: fol || [], posts: posts || [], disc: disc || [], demo: demo || [] });
    } catch (e) { console.error("Erro ao carregar:", e); }
    setLoading(false);
  }, [client]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const selProfiles = useMemo(() => sel === "all" ? profiles : profiles.filter((p) => p.id === sel), [profiles, sel]);
  const selIds = useMemo(() => new Set(selProfiles.map((p) => p.id)), [selProfiles]);

  const totals = useMemo(() => {
    const disc = dbData.disc.filter((d) => selIds.has(d.profile_id));
    const eng = dbData.eng.filter((d) => selIds.has(d.profile_id));
    const latest = {};
    for (const d of disc) if (!latest[d.profile_id] || d.snapshot_date > latest[d.profile_id].snapshot_date) latest[d.profile_id] = d;
    const latArr = Object.values(latest);
    const totI = eng.reduce((s, d) => s + d.impressions, 0);
    const totE = eng.reduce((s, d) => s + d.engagements, 0);
    return {
      impressions: latArr.reduce((s, d) => s + (d.impressions || 0), 0),
      membersReached: latArr.reduce((s, d) => s + (d.members_reached || 0), 0),
      followers: latArr.reduce((s, d) => s + (d.total_followers || 0), 0),
      engRate: totI > 0 ? ((totE / totI) * 100).toFixed(2) : "0.00",
    };
  }, [dbData.disc, dbData.eng, selIds]);

  const impChart = useMemo(() => {
    const months = new Set(dbData.eng.map((d) => d.date?.slice(0, 7)).filter(Boolean));
    const byP = {};
    profiles.forEach((p) => { byP[p.id] = {}; dbData.eng.filter((d) => d.profile_id === p.id).forEach((d) => { const mo = d.date?.slice(0, 7); if (mo) byP[p.id][mo] = (byP[p.id][mo] || 0) + d.impressions; }); });
    return Array.from(months).sort().map((mo) => { const r = { month: fmtMonth(mo) }; profiles.forEach((p) => { r[p.name] = byP[p.id]?.[mo] || 0; }); return r; });
  }, [dbData.eng, profiles]);

  const folChart = useMemo(() => {
    const months = new Set(dbData.fol.map((d) => d.date?.slice(0, 7)).filter(Boolean));
    const byP = {};
    profiles.forEach((p) => { byP[p.id] = {}; dbData.fol.filter((d) => d.profile_id === p.id).forEach((d) => { const mo = d.date?.slice(0, 7); if (mo) byP[p.id][mo] = (byP[p.id][mo] || 0) + d.new_followers; }); });
    return Array.from(months).sort().map((mo) => { const r = { month: fmtMonth(mo) }; profiles.forEach((p) => { r[p.name] = byP[p.id]?.[mo] || 0; }); return r; });
  }, [dbData.fol, profiles]);

  const topByEng = useMemo(() =>
    dbData.posts.filter((p) => selIds.has(p.profile_id)).sort((a, b) => b.engagements - a.engagements).slice(0, 10)
      .map((p) => ({ ...p, profileName: profiles.find((x) => x.id === p.profile_id)?.name || "?", color: COLORS[profiles.findIndex((x) => x.id === p.profile_id) % COLORS.length] })),
    [dbData.posts, selIds, profiles]
  );

  const topByImp = useMemo(() =>
    dbData.posts.filter((p) => selIds.has(p.profile_id)).sort((a, b) => b.impressions - a.impressions).slice(0, 10)
      .map((p) => ({ ...p, profileName: profiles.find((x) => x.id === p.profile_id)?.name || "?", color: COLORS[profiles.findIndex((x) => x.id === p.profile_id) % COLORS.length] })),
    [dbData.posts, selIds, profiles]
  );

  const demProfile = useMemo(() => selProfiles[0] || null, [selProfiles]);
  const demoItems = useMemo(() => {
    if (!demProfile) return {};
    const r = {};
    dbData.demo.filter((d) => d.profile_id === demProfile.id).forEach((item) => { if (!r[item.category]) r[item.category] = []; r[item.category].push({ label: item.value, pct: item.percentage }); });
    return r;
  }, [dbData.demo, demProfile]);

  if (loading) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "#F1F5F9", fontFamily: "system-ui,sans-serif" }}>
      <div style={{ textAlign: "center", color: "#94A3B8" }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
        <div style={{ fontSize: 14 }}>Carregando dados...</div>
      </div>
    </div>
  );

  if (!profiles.length) return (
    <div style={{ minHeight: "100vh", background: "#F1F5F9", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui,sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: 48, maxWidth: 400, textAlign: "center", boxShadow: "0 4px 20px rgba(0,0,0,0.08)" }}>
        <div style={{ fontSize: 56, marginBottom: 16 }}>📊</div>
        <div style={{ fontSize: 18, fontWeight: 700, color: "#0F172A", marginBottom: 8 }}>Banco conectado!</div>
        <div style={{ fontSize: 13, color: "#94A3B8", marginBottom: 24, lineHeight: 1.7 }}>Faça o upload dos .xlsx exportados do LinkedIn para popular o dashboard</div>
        <Btn onClick={() => setShowUpload(true)}>Primeiro upload →</Btn>
      </div>
      {showUpload && <UploadModal client={client} existingProfiles={[]} onClose={() => setShowUpload(false)} onDone={() => { setShowUpload(false); loadAll(); }} />}
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: "#F1F5F9", fontFamily: "system-ui,sans-serif" }}>

      {/* Nav */}
      <div style={{ background: "#fff", borderBottom: "1px solid #E2E8F0", position: "sticky", top: 0, zIndex: 50, boxShadow: "0 1px 3px rgba(0,0,0,0.04)" }}>
        <div style={{ maxWidth: 1200, margin: "0 auto", padding: "0 20px", display: "flex", alignItems: "stretch", height: 52, gap: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 16, marginRight: 8, borderRight: "1px solid #F1F5F9", flexShrink: 0 }}>
            <div style={{ width: 26, height: 26, background: "#0077B5", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center" }}>
              <span style={{ color: "#fff", fontWeight: 800, fontSize: 13 }}>H</span>
            </div>
            <span style={{ fontWeight: 700, fontSize: 13, color: "#0F172A", whiteSpace: "nowrap" }}>Hart Analytics</span>
          </div>

          {[["overview", "Visão Geral"], ["posts", "Top Posts"], ["audience", "Audiência"]].map(([k, l]) => (
            <button key={k} onClick={() => setTab(k)} style={{ padding: "0 14px", height: "100%", border: "none", borderBottom: tab === k ? "2px solid #0077B5" : "2px solid transparent", background: "none", cursor: "pointer", fontSize: 13, fontWeight: tab === k ? 600 : 400, color: tab === k ? "#0077B5" : "#64748B", transition: "all 0.15s", flexShrink: 0 }}>{l}</button>
          ))}

          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 5, flexShrink: 0, flexWrap: "wrap" }}>
            {["all", ...profiles.map((p) => p.id)].map((v) => {
              const label = v === "all" ? "Todos" : profiles.find((p) => p.id === v)?.name || v;
              const idx = v === "all" ? -1 : profiles.findIndex((p) => p.id === v);
              const color = v === "all" ? "#0077B5" : COLORS[idx % COLORS.length];
              const isA = sel === v;
              return <button key={v} onClick={() => setSel(v)} style={{ padding: "3px 10px", borderRadius: 20, border: `1px solid ${isA ? color : "#E2E8F0"}`, background: isA ? color : "#fff", color: isA ? "#fff" : "#64748B", fontSize: 12, fontWeight: isA ? 600 : 400, cursor: "pointer", transition: "all 0.15s", whiteSpace: "nowrap" }}>{label}</button>;
            })}
            <button onClick={() => setShowUpload(true)} style={{ padding: "4px 12px", borderRadius: 20, background: "#0077B5", color: "#fff", border: "none", fontSize: 12, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}>+ Upload</button>
            <button onClick={onLogout} style={{ background: "none", border: "none", fontSize: 11, color: "#CBD5E1", cursor: "pointer", padding: "3px 6px" }}>Sair</button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div style={{ maxWidth: 1200, margin: "0 auto", padding: 24 }}>

        {/* ── OVERVIEW ── */}
        {tab === "overview" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 14, marginBottom: 20 }}>
              <StatCard label="Impressões" value={fmtNum(totals.impressions)} sub="Total dos posts" accent="#0077B5" />
              <StatCard label="Pessoas Alcançadas" value={fmtNum(totals.membersReached)} sub="Membros únicos" accent="#10B981" />
              <StatCard label="Seguidores" value={fmtNum(totals.followers)} sub="Total acumulado" accent="#F59E0B" />
              <StatCard label="Taxa de Engajamento" value={totals.engRate + "%"} sub="Histórica média" accent="#EF4444" />
            </div>

            {profiles.length > 1 && (
              <div style={{ ...card, padding: 20, marginBottom: 18, overflowX: "auto" }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: "#0F172A", marginBottom: 14 }}>Comparativo entre Perfis</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
                  <thead><tr style={{ borderBottom: "2px solid #F1F5F9" }}>
                    {["Perfil", "Impressões", "Alcance", "Seguidores", "Tx. Eng.", "Posts", "Melhor Eng.", "Melhor Alcance"].map((h, j) => (
                      <th key={h} style={{ padding: "8px 12px", textAlign: j > 0 ? "right" : "left", color: "#94A3B8", fontWeight: 500, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {profiles.map((p, i) => {
                      const disc = dbData.disc.filter((d) => d.profile_id === p.id);
                      const lat = disc.reduce((a, b) => (!a || b.snapshot_date > a.snapshot_date) ? b : a, null) || {};
                      const eng = dbData.eng.filter((d) => d.profile_id === p.id);
                      const totI = eng.reduce((s, d) => s + d.impressions, 0), totE = eng.reduce((s, d) => s + d.engagements, 0);
                      const er = totI > 0 ? ((totE / totI) * 100).toFixed(2) : "0.00";
                      const pP = dbData.posts.filter((d) => d.profile_id === p.id);
                      const bE = [...pP].sort((a, b) => b.engagements - a.engagements)[0];
                      const bI = [...pP].sort((a, b) => b.impressions - a.impressions)[0];
                      return (
                        <tr key={p.id} style={{ borderBottom: "1px solid #F8FAFC" }}>
                          <td style={{ padding: "10px 12px" }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ width: 10, height: 10, borderRadius: "50%", background: COLORS[i % COLORS.length] }} /><span style={{ fontWeight: 600, color: "#334155" }}>{p.name}</span></div></td>
                          <td style={{ padding: "10px 12px", textAlign: "right", color: "#475569", fontWeight: 500 }}>{fmtNum(lat.impressions || 0)}</td>
                          <td style={{ padding: "10px 12px", textAlign: "right", color: "#475569" }}>{fmtNum(lat.members_reached || 0)}</td>
                          <td style={{ padding: "10px 12px", textAlign: "right", color: "#475569" }}>{fmtNum(lat.total_followers || 0)}</td>
                          <td style={{ padding: "10px 12px", textAlign: "right" }}><span style={{ background: "#F0FDF4", color: "#16A34A", padding: "2px 8px", borderRadius: 20, fontWeight: 600, fontSize: 12 }}>{er}%</span></td>
                          <td style={{ padding: "10px 12px", textAlign: "right", color: "#64748B" }}>{pP.length}</td>
                          <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700 }}>{bE ? <a href={bE.post_url} target="_blank" rel="noopener noreferrer" style={{ color: COLORS[i % COLORS.length], textDecoration: "none" }}>{bE.engagements} ↗</a> : <span style={{ color: "#CBD5E1" }}>—</span>}</td>
                          <td style={{ padding: "10px 12px", textAlign: "right", fontWeight: 700 }}>{bI ? <a href={bI.post_url} target="_blank" rel="noopener noreferrer" style={{ color: COLORS[i % COLORS.length], textDecoration: "none" }}>{fmtNum(bI.impressions)} ↗</a> : <span style={{ color: "#CBD5E1" }}>—</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <div style={{ ...card, padding: 22 }}>
                <div style={{ fontWeight: 600, color: "#0F172A", marginBottom: 14, fontSize: 14 }}>Impressões Mensais</div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={impChart} margin={{ right: 8, left: -8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F8FAFC" />
                    <XAxis dataKey="month" tick={{ fontSize: 10, fill: "#94A3B8" }} />
                    <YAxis tick={{ fontSize: 10, fill: "#94A3B8" }} tickFormatter={fmtNum} />
                    <Tooltip formatter={(v, n) => [fmtNum(v), n]} />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    {profiles.map((p, i) => <Line key={p.id} type="monotone" dataKey={p.name} stroke={COLORS[i % COLORS.length]} strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />)}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div style={{ ...card, padding: 22 }}>
                <div style={{ fontWeight: 600, color: "#0F172A", marginBottom: 14, fontSize: 14 }}>Novos Seguidores / Mês</div>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={folChart} margin={{ right: 8, left: -8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#F8FAFC" />
                    <XAxis dataKey="month" tick={{ fontSize: 10, fill: "#94A3B8" }} />
                    <YAxis tick={{ fontSize: 10, fill: "#94A3B8" }} />
                    <Tooltip /><Legend wrapperStyle={{ fontSize: 12 }} />
                    {profiles.map((p, i) => <Bar key={p.id} dataKey={p.name} fill={COLORS[i % COLORS.length]} radius={[3, 3, 0, 0]} maxBarSize={32} />)}
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </>
        )}

        {/* ── POSTS ── */}
        {tab === "posts" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            {[["🏆 Top por Engajamento", topByEng, "Eng."], ["👁 Top por Impressões", topByImp, "Views"]].map(([title, rows, col]) => (
              <div key={title} style={{ ...card, padding: 22 }}>
                <div style={{ fontWeight: 600, color: "#0F172A", marginBottom: 16, fontSize: 14 }}>{title}</div>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                  <thead><tr style={{ borderBottom: "1px solid #F1F5F9" }}>
                    {["#", "Perfil", "Data", col].map((h, j) => <th key={h} style={{ padding: "6px 8px", textAlign: j === 3 ? "right" : "left", color: "#94A3B8", fontWeight: 500, fontSize: 11 }}>{h}</th>)}
                  </tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} style={{ borderBottom: "1px solid #F8FAFC" }}>
                        <td style={{ padding: "9px 8px", color: "#CBD5E1", fontWeight: 600, width: 24 }}>{i + 1}</td>
                        <td style={{ padding: "9px 8px" }}><a href={r.post_url} target="_blank" rel="noopener noreferrer" style={{ color: r.color, fontWeight: 700, textDecoration: "none" }}>{r.profileName} ↗</a></td>
                        <td style={{ padding: "9px 8px", color: "#64748B" }}>{fmtDate(r.publish_date)}</td>
                        <td style={{ padding: "9px 8px", textAlign: "right", fontWeight: 700, color: "#0F172A" }}>{fmtNum(col === "Eng." ? r.engagements : r.impressions)}</td>
                      </tr>
                    ))}
                    {!rows.length && <tr><td colSpan={4} style={{ padding: 32, textAlign: "center", color: "#CBD5E1" }}>Sem dados</td></tr>}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
        )}

        {/* ── AUDIENCE ── */}
        {tab === "audience" && (
          demProfile ? (
            <>
              <div style={{ background: "#EFF6FF", border: "1px solid #BFDBFE", borderRadius: 10, padding: "10px 16px", marginBottom: 18, fontSize: 13, color: "#1D4ED8" }}>
                📊 Audiência de <strong>{demProfile.name}</strong> — selecione outro perfil acima para comparar
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
                <DemoBar title="Senioridade" items={demoItems["seniority"] || []} color="#0077B5" />
                <DemoBar title="Setores" items={demoItems["industries"] || []} color="#10B981" />
                <DemoBar title="Cargos" items={demoItems["jobTitles"] || []} color="#F59E0B" />
                <DemoBar title="Localização" items={demoItems["locations"] || []} color="#8B5CF6" />
              </div>
            </>
          ) : (
            <div style={{ textAlign: "center", padding: "80px 20px", color: "#CBD5E1" }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>📊</div>
              <div>Selecione um perfil acima para ver a audiência</div>
            </div>
          )
        )}
      </div>

      {showUpload && <UploadModal client={client} existingProfiles={profiles} onClose={() => setShowUpload(false)} onDone={() => { setShowUpload(false); loadAll(); }} />}
    </div>
  );
}

// ── Tela de definição de senha (convite / recovery) ───────────────────────────
function SetPasswordScreen({ token, onDone }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [ok, setOk] = useState(false);

  const save = async () => {
    if (pass.length < 8) { setErr("A senha precisa ter pelo menos 8 caracteres."); return; }
    if (pass !== confirm) { setErr("As senhas não coincidem."); return; }
    setLoading(true); setErr("");
    try {
      const client = buildClient(token);
      const data = await client.auth.updatePassword(pass);
      if (data.error) { setErr(data.error.message || "Erro ao salvar senha."); setLoading(false); return; }
      setOk(true);
      setTimeout(() => onDone(token), 1500);
    } catch (e) { setErr(e.message); setLoading(false); }
  };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#EFF6FF,#F8FAFC)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "system-ui,sans-serif", padding: 24 }}>
      <div style={{ background: "#fff", borderRadius: 20, padding: 40, maxWidth: 380, width: "100%", boxShadow: "0 8px 40px rgba(0,119,181,0.12)" }}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ width: 52, height: 52, background: "#0077B5", borderRadius: 14, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 12 }}>
            <span style={{ color: "#fff", fontWeight: 800, fontSize: 22 }}>H</span>
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: "#0F172A", marginBottom: 4 }}>Criar sua senha</div>
          <div style={{ fontSize: 13, color: "#94A3B8" }}>Defina uma senha para acessar o Hart Analytics</div>
        </div>
        {ok ? (
          <div style={{ textAlign: "center", padding: "20px 0" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>✅</div>
            <div style={{ fontWeight: 600, color: "#16A34A" }}>Senha criada! Entrando...</div>
          </div>
        ) : (
          <>
            <div onKeyDown={(e) => { if (e.key === "Enter" && pass && confirm) save(); }}>
              <Input label="Nova senha" type="password" value={pass} onChange={setPass} placeholder="mínimo 8 caracteres" autoFocus />
              <Input label="Confirmar senha" type="password" value={confirm} onChange={setConfirm} placeholder="repita a senha" />
            </div>
            {err && <div style={{ background: "#FEF2F2", color: "#DC2626", borderRadius: 8, padding: "10px 14px", fontSize: 12, marginBottom: 12 }}>{err}</div>}
            <Btn full onClick={save} disabled={!pass || !confirm || loading}>{loading ? "Salvando..." : "Definir senha e entrar →"}</Btn>
          </>
        )}
      </div>
    </div>
  );
}

// ── Parse hash from Supabase auth redirect ────────────────────────────────────
function parseHash() {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = Object.fromEntries(new URLSearchParams(hash));
  return params.access_token ? params : null;
}

// ── App root ──────────────────────────────────────────────────────────────────
export default function App() {
  const [session, setSession] = useState(() => {
    try { return JSON.parse(localStorage.getItem("hart_session") || "null"); } catch { return null; }
  });

  const hashParams = parseHash();
  const isAuthCallback = hashParams && ["recovery", "invite", "signup"].includes(hashParams.type);

  const handleLogin = (sess) => {
    localStorage.setItem("hart_session", JSON.stringify(sess));
    setSession(sess);
  };

  const handleLogout = () => {
    try { buildClient(session?.access_token).auth.signOut(); } catch {}
    localStorage.removeItem("hart_session");
    setSession(null);
  };

  const handlePasswordSet = (token) => {
    window.location.hash = "";
    handleLogin({ access_token: token });
  };

  if (isAuthCallback) return <SetPasswordScreen token={hashParams.access_token} onDone={handlePasswordSet} />;
  if (!session?.access_token) return <LoginScreen onLogin={handleLogin} />;
  return <Dashboard session={session} onLogout={handleLogout} />;
}
