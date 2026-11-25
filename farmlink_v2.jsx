import { useState, useEffect, useRef, useMemo } from "react";

// ─── FONTS ───────────────────────────────────────────────────────
const FONTS = <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&family=Fraunces:wght@400;500;600;700;800;900&display=swap" rel="stylesheet" />;

// ─── DATA ────────────────────────────────────────────────────────
const FARMS = [
  { id: "f1", name: "Green Acres Farm", contact: "+1 501-555-0201", location: "Scott, AR", emoji: "🌱", specialty: "Heirloom Vegetables" },
  { id: "f2", name: "Riverside Berries", contact: "+1 501-555-0202", location: "Cabot, AR", emoji: "🫐", specialty: "Berries & Stone Fruit" },
  { id: "f3", name: "Ozark Greens Co-op", contact: "+1 501-555-0203", location: "Conway, AR", emoji: "🥬", specialty: "Greens & Herbs" },
];

const MARKETS = [
  { id: "m1", name: "ABC Market", priority: 1, contact: "+1 501-555-0101", active: true, type: "Grocery", deliveryPref: "pickup" },
  { id: "m2", name: "River Market", priority: 2, contact: "+1 501-555-0102", active: true, type: "Farmers Market", deliveryPref: "delivery" },
  { id: "m3", name: "Hillcrest Co-op", priority: 3, contact: "+1 501-555-0103", active: true, type: "Co-op", deliveryPref: "delivery" },
  { id: "m4", name: "Heights Corner", priority: 4, contact: "+1 501-555-0104", active: true, type: "Restaurant", deliveryPref: "pickup" },
  { id: "m5", name: "SoMa Kitchen", priority: 5, contact: "+1 501-555-0105", active: false, type: "Restaurant", deliveryPref: "delivery" },
];

const INVENTORY = [
  { id: "i1", farmId: "f1", product: "Cherokee Purple Tomatoes", qty: 100, remaining: 60, unit: "lb", price: 2.99, harvestDate: "2026-03-21", status: "available", category: "Vegetables" },
  { id: "i2", farmId: "f1", product: "Sweet Basil", qty: 40, remaining: 20, unit: "bunch", price: 1.50, harvestDate: "2026-03-21", status: "available", category: "Herbs" },
  { id: "i3", farmId: "f2", product: "Strawberries", qty: 80, remaining: 35, unit: "lb", price: 4.50, harvestDate: "2026-03-21", status: "available", category: "Berries" },
  { id: "i4", farmId: "f2", product: "Blackberries", qty: 30, remaining: 30, unit: "pint", price: 5.00, harvestDate: "2026-03-21", status: "available", category: "Berries" },
  { id: "i5", farmId: "f1", product: "Mixed Greens", qty: 25, remaining: 0, unit: "lb", price: 3.25, harvestDate: "2026-03-19", status: "sold", category: "Greens" },
  { id: "i6", farmId: "f3", product: "Lacinato Kale", qty: 50, remaining: 35, unit: "bunch", price: 2.25, harvestDate: "2026-03-21", status: "available", category: "Greens" },
  { id: "i7", farmId: "f3", product: "Cilantro", qty: 60, remaining: 42, unit: "bunch", price: 1.25, harvestDate: "2026-03-21", status: "available", category: "Herbs" },
  { id: "i8", farmId: "f1", product: "Jalapeños", qty: 40, remaining: 40, unit: "lb", price: 2.00, harvestDate: "2026-03-20", status: "available", category: "Vegetables" },
];

const ORDERS = [
  { id: "o1", farmId: "f1", marketId: "m1", market: "ABC Market", farm: "Green Acres Farm", items: [{ product: "Cherokee Purple Tomatoes", qty: 40, unit: "lb", price: 2.99 }], status: "confirmed", date: "2026-03-21", delivery: "pickup", deliveryTime: "7:00 AM", total: 119.60 },
  { id: "o2", farmId: "f2", marketId: "m2", market: "River Market", farm: "Riverside Berries", items: [{ product: "Strawberries", qty: 30, unit: "lb", price: 4.50 }], status: "in-transit", date: "2026-03-21", delivery: "delivery", deliveryTime: "8:30 AM", total: 135.00 },
  { id: "o3", farmId: "f1", marketId: "m3", market: "Hillcrest Co-op", farm: "Green Acres Farm", items: [{ product: "Sweet Basil", qty: 20, unit: "bunch", price: 1.50 }, { product: "Jalapeños", qty: 10, unit: "lb", price: 2.00 }], status: "pending", date: "2026-03-21", delivery: "delivery", deliveryTime: "10:00 AM", total: 50.00 },
  { id: "o4", farmId: "f3", marketId: "m1", market: "ABC Market", farm: "Ozark Greens Co-op", items: [{ product: "Lacinato Kale", qty: 15, unit: "bunch", price: 2.25 }], status: "confirmed", date: "2026-03-21", delivery: "pickup", deliveryTime: "7:00 AM", total: 33.75 },
  { id: "o5", farmId: "f2", marketId: "m4", market: "Heights Corner", farm: "Riverside Berries", items: [{ product: "Strawberries", qty: 15, unit: "lb", price: 4.50 }], status: "delivered", date: "2026-03-20", delivery: "pickup", deliveryTime: "6:30 AM", total: 67.50 },
  { id: "o6", farmId: "f1", marketId: "m2", market: "River Market", farm: "Green Acres Farm", items: [{ product: "Mixed Greens", qty: 25, unit: "lb", price: 3.25 }], status: "delivered", date: "2026-03-19", delivery: "delivery", deliveryTime: "9:00 AM", total: 81.25 },
];

const RECURRING_ORDERS = [
  { id: "r1", marketId: "m1", market: "ABC Market", farmId: "f1", farm: "Green Acres Farm", items: [{ product: "Sweet Basil", qty: 10, unit: "bunch" }], frequency: "weekly", day: "Monday", active: true, nextDelivery: "2026-03-23" },
  { id: "r2", marketId: "m2", market: "River Market", farmId: "f2", farm: "Riverside Berries", items: [{ product: "Strawberries", qty: 20, unit: "lb" }], frequency: "twice-weekly", day: "Tue & Fri", active: true, nextDelivery: "2026-03-24" },
  { id: "r3", marketId: "m3", market: "Hillcrest Co-op", farmId: "f3", farm: "Ozark Greens Co-op", items: [{ product: "Lacinato Kale", qty: 10, unit: "bunch" }, { product: "Cilantro", qty: 8, unit: "bunch" }], frequency: "weekly", day: "Wednesday", active: true, nextDelivery: "2026-03-25" },
  { id: "r4", marketId: "m4", market: "Heights Corner", farmId: "f1", farm: "Green Acres Farm", items: [{ product: "Cherokee Purple Tomatoes", qty: 20, unit: "lb" }], frequency: "weekly", day: "Thursday", active: false, nextDelivery: null },
];

const WEEKLY_SALES = [
  { day: "Mon", revenue: 285, orders: 4 },
  { day: "Tue", revenue: 412, orders: 6 },
  { day: "Wed", revenue: 198, orders: 3 },
  { day: "Thu", revenue: 367, orders: 5 },
  { day: "Fri", revenue: 523, orders: 8 },
  { day: "Sat", revenue: 641, orders: 11 },
  { day: "Sun", revenue: 338, orders: 5 },
];

const TOP_PRODUCTS = [
  { product: "Strawberries", revenue: 1215, qty: 270, unit: "lb", trend: "+18%" },
  { product: "Cherokee Purple Tomatoes", revenue: 896, qty: 300, unit: "lb", trend: "+12%" },
  { product: "Sweet Basil", revenue: 420, qty: 280, unit: "bunch", trend: "+5%" },
  { product: "Lacinato Kale", revenue: 382, qty: 170, unit: "bunch", trend: "+22%" },
  { product: "Jalapeños", revenue: 310, qty: 155, unit: "lb", trend: "-3%" },
];

// ─── SMS SCRIPTS ─────────────────────────────────────────────────
const FARMER_SMS = [
  { from: "app", text: "☀️ Good morning! Reminder: ABC Market's standing order (10 bunch Sweet Basil) is due Monday. You have 20 bunches in stock — all set?" },
  { from: "farmer", text: "yes that's good. also I pulled 100lb of cherokee tomatoes this morning" },
  { from: "app", text: "Nice harvest! 🍅 I've got Cherokee Purples at $2.99/lb on your price list. Still good, or want to adjust?", delay: 900 },
  { from: "farmer", text: "bump to 3.25, they're looking great this week" },
  { from: "app", text: "Updated to $3.25/lb.\n\nWho should I notify?\n\n1️⃣ ABC Market (Priority)\n2️⃣ All active markets\n3️⃣ Let me pick", delay: 800 },
  { from: "farmer", text: "ABC first, everyone else in an hour" },
  { from: "app", text: "Done! 📨\n\n✅ ABC Market — notified now\n⏳ River Market — 10:00 AM\n⏳ Hillcrest Co-op — 10:00 AM\n⏳ Heights Corner — 10:00 AM\n\nBTW — Hillcrest ordered kale from Ozark Greens this morning. They might pair tomatoes with that. Want me to suggest a bundle to them?", delay: 1200 },
  { from: "farmer", text: "yeah good idea" },
  { from: "app", text: "I'll pitch them a \"Salsa Garden\" bundle: Cherokee Tomatoes + Cilantro (from Ozark Greens) + your Jalapeños. I'll coordinate with Ozark Greens on the cilantro side. 🌶️", delay: 1000 },
  { from: "farmer", text: "love it. what's my delivery schedule look like today?" },
  { from: "app", text: "Today's deliveries:\n\n🟢 7:00 AM — ABC Market (pickup)\n   40lb Tomatoes + 15 bunch Kale (Ozark)\n\n🔵 8:30 AM — River Market\n   30lb Strawberries (Riverside delivering)\n\n🟡 10:00 AM — Hillcrest Co-op\n   20 bunch Basil + 10lb Jalapeños\n   ⚠️ Pending confirmation\n\nWant me to text Hillcrest to confirm?", delay: 1200 },
  { from: "farmer", text: "yes please" },
  { from: "app", text: "Sent! I'll let you know when they confirm. 👍\n\n📊 Quick stats: You're up 15% this week vs last. Strawberries and tomatoes are your hot sellers.", delay: 900 },
];

const MARKET_SMS = [
  { from: "app", text: "🌿 Fresh from Green Acres Farm!\n\n🍅 100lb Cherokee Purple Tomatoes — $3.25/lb\nHarvested this morning. You're getting first pick!" },
  { from: "market", text: "great timing, we're low on tomatoes. 40lb please" },
  { from: "app", text: "40lb Cherokee Purples @ $3.25/lb = $130.00\n\nPickup at 7 AM as usual?", delay: 800 },
  { from: "market", text: "yes" },
  { from: "app", text: "Confirmed! ✅ Order #1048\n\nYou also have a pickup from Ozark Greens at the same time:\n• 15 bunch Lacinato Kale — $33.75\n\nCombined pickup total: $163.75\n\nBoth farms have been notified.", delay: 1000 },
  { from: "market", text: "perfect. do I have any standing orders coming this week?" },
  { from: "app", text: "This week's standing orders:\n\n📅 Mon — 10 bunch Sweet Basil (Green Acres) — $15.00\n📅 Tue — 20lb Strawberries (Riverside) — $90.00\n📅 Fri — 20lb Strawberries (Riverside) — $90.00\n\nTotal recurring: $195.00\n\nAll farms have confirmed availability. Want to adjust any of these?", delay: 1100 },
  { from: "market", text: "bump the strawberries to 25lb on both" },
  { from: "app", text: "Updated! Strawberry orders now 25lb each.\n\nTue: $112.50 | Fri: $112.50\n\nRiverside Berries has been notified. They've got 80lb fresh today so you're covered. 🍓", delay: 900 },
  { from: "market", text: "what's available across all farms right now?" },
  { from: "app", text: "Available now from all connected farms:\n\n🌱 Green Acres Farm:\n  🍅 Cherokee Tomatoes — 60lb @ $3.25\n  🌿 Sweet Basil — 20 bunch @ $1.50\n  🌶️ Jalapeños — 40lb @ $2.00\n\n🫐 Riverside Berries:\n  🍓 Strawberries — 35lb @ $4.50\n  🫐 Blackberries — 30 pint @ $5.00\n\n🥬 Ozark Greens:\n  🥬 Lacinato Kale — 20 bunch @ $2.25\n  🌿 Cilantro — 42 bunch @ $1.25\n\nWant to order from any of these?", delay: 1300 },
];

// ─── ICONS ──────────────────────────────────────────────────────
const Icon = ({ name, size = 18 }) => {
  const d = {
    send: <><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></>,
    package: <><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></>,
    cart: <><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></>,
    dollar: <><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></>,
    store: <><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></>,
    msg: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></>,
    leaf: <><path d="M17 8C8 10 5.9 16.17 3.82 21.34l1.89.66.95-2.3c.48.17.98.3 1.34.3C19 20 22 3 22 3c-1 2-8 2.25-13 3.25S2 11.5 2 13.5s1.75 3.75 1.75 3.75"/></>,
    edit: <><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></>,
    arrow: <><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></>,
    truck: <><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></>,
    clock: <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>,
    repeat: <><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></>,
    chart: <><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></>,
    trendUp: <><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></>,
    check: <><polyline points="20 6 9 17 4 12"/></>,
    x: <><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></>,
    bell: <><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></>,
    grid: <><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></>,
    map: <><polygon points="1 6 1 22 8 18 16 22 23 18 23 2 16 6 8 2 1 6"/><line x1="8" y1="2" x2="8" y2="18"/><line x1="16" y1="6" x2="16" y2="22"/></>,
    users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></>,
    star: null,
  };
  if (name === "star") return <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
  if (name === "starEmpty") return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>;
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{d[name]}</svg>;
};

// ─── SHARED COMPONENTS ──────────────────────────────────────────
const StatusBadge = ({ status }) => {
  const c = {
    available: { bg: "#e8f5e9", color: "#2e7d32", label: "Available" },
    partial: { bg: "#fff3e0", color: "#e65100", label: "Partial" },
    sold: { bg: "#eee", color: "#777", label: "Sold Out" },
    confirmed: { bg: "#e8f5e9", color: "#2e7d32", label: "Confirmed" },
    pending: { bg: "#fff8e1", color: "#f9a825", label: "Pending" },
    delivered: { bg: "#e3f2fd", color: "#1565c0", label: "Delivered" },
    "in-transit": { bg: "#f3e5f5", color: "#7b1fa2", label: "In Transit" },
  }[status] || { bg: "#eee", color: "#666", label: status };
  return <span style={{ background: c.bg, color: c.color, padding: "3px 10px", borderRadius: 20, fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3, textTransform: "uppercase", whiteSpace: "nowrap" }}>{c.label}</span>;
};

const TabBar = ({ active, onNav, items }) => (
  <div style={{ display: "flex", gap: 3, padding: 3, background: "#f0ebe4", borderRadius: 10, flexWrap: "wrap" }}>
    {items.map(item => (
      <button key={item.id} onClick={() => onNav(item.id)} style={{
        display: "flex", alignItems: "center", gap: 5, padding: "7px 12px", borderRadius: 7, border: "none",
        background: active === item.id ? "#fff" : "transparent", color: active === item.id ? "#2d5016" : "#8a7e72",
        fontWeight: active === item.id ? 700 : 500, fontSize: 12, cursor: "pointer",
        boxShadow: active === item.id ? "0 1px 3px rgba(0,0,0,0.08)" : "none", transition: "all 0.15s", fontFamily: "'DM Sans', sans-serif",
      }}>
        <Icon name={item.icon} size={14} />
        {item.label}
        {item.badge > 0 && <span style={{ background: "#e65100", color: "#fff", fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 10 }}>{item.badge}</span>}
      </button>
    ))}
  </div>
);

const Card = ({ children, style }) => (
  <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e8e0d6", ...style }}>{children}</div>
);

const SectionTitle = ({ children, action }) => (
  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
    <h3 style={{ margin: 0, color: "#2c2416", fontFamily: "'Fraunces', serif", fontWeight: 700, fontSize: 16 }}>{children}</h3>
    {action}
  </div>
);

const Btn = ({ children, primary, small, onClick, style: s }) => (
  <button onClick={onClick} style={{
    background: primary ? "linear-gradient(135deg, #2d5016, #4a7c28)" : "#f5f0ea", color: primary ? "#fff" : "#5a5044",
    border: "none", padding: small ? "5px 12px" : "8px 16px", borderRadius: 8,
    fontSize: small ? 11 : 12, fontWeight: 600, cursor: "pointer", fontFamily: "'DM Sans', sans-serif", ...s,
  }}>{children}</button>
);

const EMOJI_MAP = { Vegetables: "🍅", Herbs: "🌿", Berries: "🍓", Greens: "🥬", default: "📦" };

// ─── SMS CHAT ───────────────────────────────────────────────────
const SMSChat = ({ script, userRole, title, subtitle }) => {
  const [messages, setMessages] = useState([]);
  const [scriptIdx, setScriptIdx] = useState(0);
  const [isTyping, setIsTyping] = useState(false);
  const [autoPlay, setAutoPlay] = useState(false);
  const chatRef = useRef(null);
  const timerRef = useRef(null);

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, isTyping]);

  useEffect(() => {
    if (!autoPlay || scriptIdx >= script.length) { setIsTyping(false); return; }
    const msg = script[scriptIdx];
    const isUser = msg.from === userRole;
    const delay = isUser ? 500 : (msg.delay || 800);
    if (!isUser) setIsTyping(true);
    timerRef.current = setTimeout(() => {
      setIsTyping(false);
      setMessages(prev => [...prev, { ...msg, id: Date.now() }]);
      setScriptIdx(prev => prev + 1);
    }, delay);
    return () => clearTimeout(timerRef.current);
  }, [autoPlay, scriptIdx, script, userRole]);

  const pushNext = () => {
    if (scriptIdx >= script.length) return;
    const msg = script[scriptIdx];
    setMessages(prev => [...prev, { ...msg, id: Date.now() }]);
    setScriptIdx(prev => prev + 1);
    const next = script[scriptIdx + 1];
    if (next && next.from !== (script[scriptIdx]?.from)) {
      setIsTyping(true);
      setTimeout(() => {
        setIsTyping(false);
        setMessages(prev => [...prev, { ...next, id: Date.now() + 1 }]);
        setScriptIdx(prev => prev + 2);
      }, next.delay || 800);
    }
  };

  const nextMsg = script[scriptIdx];
  const canSend = nextMsg && nextMsg.from === userRole;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#f5f0ea", borderRadius: 14, overflow: "hidden", border: "1px solid #e0d8ce" }}>
      <div style={{ background: "linear-gradient(135deg, #2d5016 0%, #4a7c28 100%)", padding: "14px 18px", display: "flex", alignItems: "center", gap: 10 }}>
        <div style={{ width: 34, height: 34, borderRadius: "50%", background: "rgba(255,255,255,0.18)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16 }}>
          <Icon name="leaf" size={17} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ color: "#fff", fontWeight: 700, fontSize: 13.5 }}>{title}</div>
          <div style={{ color: "rgba(255,255,255,0.65)", fontSize: 10.5 }}>{subtitle || "FarmLink Smart Assistant"}</div>
        </div>
        {!autoPlay && messages.length === 0 && (
          <Btn onClick={() => setAutoPlay(true)} small style={{ background: "rgba(255,255,255,0.18)", color: "#fff" }}>▶ Auto</Btn>
        )}
      </div>
      <div ref={chatRef} style={{ flex: 1, overflow: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 6 }}>
        {messages.length === 0 && !autoPlay && (
          <div style={{ textAlign: "center", padding: 30, color: "#8a7e72", fontSize: 12.5 }}>Click "Auto" to watch the conversation, or step through manually below</div>
        )}
        {messages.map(msg => {
          const isUser = msg.from === userRole;
          return (
            <div key={msg.id} style={{ display: "flex", justifyContent: isUser ? "flex-end" : "flex-start", animation: "fadeSlide 0.25s ease" }}>
              <div style={{
                maxWidth: "82%", padding: "9px 13px",
                borderRadius: isUser ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
                background: isUser ? "linear-gradient(135deg, #2d5016, #4a7c28)" : "#fff",
                color: isUser ? "#fff" : "#2c2416", fontSize: 13, lineHeight: 1.5, whiteSpace: "pre-line",
                boxShadow: isUser ? "none" : "0 1px 2px rgba(0,0,0,0.06)",
              }}>{msg.text}</div>
            </div>
          );
        })}
        {isTyping && (
          <div style={{ display: "flex" }}>
            <div style={{ background: "#fff", padding: "10px 16px", borderRadius: "16px 16px 16px 4px", boxShadow: "0 1px 2px rgba(0,0,0,0.06)", display: "flex", gap: 4 }}>
              {[0, 1, 2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#a09484", animation: `bounce 1.2s infinite ${i * 0.15}s` }} />)}
            </div>
          </div>
        )}
      </div>
      {!autoPlay && scriptIdx < script.length && (
        <div style={{ padding: "10px 14px", background: "#fff", borderTop: "1px solid #e8e0d6" }}>
          <button onClick={pushNext} style={{
            width: "100%", padding: "9px 14px", borderRadius: 20,
            background: canSend ? "linear-gradient(135deg, #2d5016, #4a7c28)" : "#e8e0d6",
            color: canSend ? "#fff" : "#8a7e72", border: "none", cursor: canSend ? "pointer" : "default",
            fontSize: 12, fontWeight: 600, fontFamily: "'DM Sans', sans-serif",
          }}>
            {canSend ? `Send: "${nextMsg.text.slice(0, 50)}${nextMsg.text.length > 50 ? '...' : ''}"` : "Waiting for response..."}
          </button>
        </div>
      )}
      {(autoPlay || scriptIdx >= script.length) && scriptIdx >= script.length && (
        <div style={{ padding: "10px 14px", background: "#fff", borderTop: "1px solid #e8e0d6", textAlign: "center", fontSize: 12, color: "#8a7e72" }}>
          ✅ Demo complete
        </div>
      )}
    </div>
  );
};

// ─── MINI BAR CHART ─────────────────────────────────────────────
const MiniBarChart = ({ data, valueKey, labelKey, color = "#4a7c28", height = 140 }) => {
  const max = Math.max(...data.map(d => d[valueKey]));
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height, padding: "0 4px" }}>
      {data.map((d, i) => {
        const h = (d[valueKey] / max) * (height - 24);
        return (
          <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
            <div style={{ fontSize: 9, fontWeight: 700, color: "#5a5044" }}>${d[valueKey]}</div>
            <div style={{ width: "100%", height: h, background: `linear-gradient(180deg, ${color}, ${color}88)`, borderRadius: "4px 4px 0 0", transition: "height 0.3s ease", minHeight: 4 }} />
            <div style={{ fontSize: 10, color: "#8a7e72", fontWeight: 600 }}>{d[labelKey]}</div>
          </div>
        );
      })}
    </div>
  );
};

// ─── DELIVERY TIMELINE ──────────────────────────────────────────
const DeliveryTimeline = () => {
  const deliveries = ORDERS.filter(o => o.date === "2026-03-21").sort((a, b) => a.deliveryTime.localeCompare(b.deliveryTime));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
      {deliveries.map((d, i) => (
        <div key={d.id} style={{ display: "flex", gap: 14, padding: "14px 0", borderBottom: i < deliveries.length - 1 ? "1px solid #f0ebe4" : "none" }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 48, flexShrink: 0 }}>
            <div style={{
              width: 10, height: 10, borderRadius: "50%",
              background: d.status === "delivered" ? "#1565c0" : d.status === "in-transit" ? "#7b1fa2" : d.status === "confirmed" ? "#2e7d32" : "#f9a825",
              border: "2px solid #fff", boxShadow: "0 0 0 2px " + (d.status === "delivered" ? "#1565c0" : d.status === "in-transit" ? "#7b1fa2" : d.status === "confirmed" ? "#2e7d32" : "#f9a825") + "44",
            }} />
            {i < deliveries.length - 1 && <div style={{ width: 2, flex: 1, background: "#e8e0d6", marginTop: 4 }} />}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 13, color: "#2c2416" }}>{d.deliveryTime}</span>
                <span style={{ fontSize: 12, color: "#8a7e72", marginLeft: 8 }}>{d.market}</span>
              </div>
              <StatusBadge status={d.status} />
            </div>
            <div style={{ fontSize: 12, color: "#6b5f53", marginTop: 4 }}>
              {d.items.map(it => `${it.qty}${it.unit} ${it.product}`).join(", ")}
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 11 }}>
              <span style={{ color: "#8a7e72" }}>
                <Icon name={d.delivery === "delivery" ? "truck" : "store"} size={12} /> {d.delivery === "delivery" ? "Delivery" : "Pickup"}
              </span>
              <span style={{ color: "#2d5016", fontWeight: 700 }}>${d.total.toFixed(2)}</span>
              <span style={{ color: "#8a7e72" }}>from {d.farm}</span>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};

// ─── RECURRING ORDERS ───────────────────────────────────────────
const RecurringOrders = ({ perspective }) => {
  const items = perspective === "farmer"
    ? RECURRING_ORDERS
    : RECURRING_ORDERS.filter(r => r.marketId === "m1"); // filter to ABC Market for demo
  return (
    <div>
      <SectionTitle action={<Btn primary small>+ New Standing Order</Btn>}>Standing Orders</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map(r => (
          <Card key={r.id} style={{ padding: 16, opacity: r.active ? 1 : 0.55 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: r.active ? "#e8f5e9" : "#f5f0ea", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <Icon name="repeat" size={18} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: 13, color: "#2c2416" }}>
                  {perspective === "farmer" ? r.market : r.farm}
                </div>
                <div style={{ fontSize: 12, color: "#8a7e72", marginTop: 2 }}>
                  {r.items.map(i => `${i.qty} ${i.unit} ${i.product}`).join(" + ")}
                </div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#2d5016" }}>
                  <Icon name="repeat" size={11} /> {r.frequency}
                </div>
                <div style={{ fontSize: 11, color: "#8a7e72", marginTop: 2 }}>{r.day}</div>
                {r.nextDelivery && <div style={{ fontSize: 10, color: "#5a5044", marginTop: 4, background: "#f5f0ea", padding: "2px 8px", borderRadius: 10 }}>Next: {r.nextDelivery.slice(5)}</div>}
              </div>
              <div style={{
                width: 36, height: 20, borderRadius: 10, cursor: "pointer",
                background: r.active ? "#4a7c28" : "#d0c8be", position: "relative", transition: "background 0.2s",
              }}>
                <div style={{
                  width: 16, height: 16, borderRadius: "50%", background: "#fff", position: "absolute", top: 2,
                  left: r.active ? 18 : 2, transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                }} />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

// ─── ANALYTICS ──────────────────────────────────────────────────
const Analytics = () => (
  <div>
    <SectionTitle>Sales Analytics</SectionTitle>
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
      <Card style={{ padding: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#8a7e72", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 14 }}>This Week's Revenue</div>
        <div style={{ fontSize: 28, fontWeight: 800, color: "#2c2416", fontFamily: "'Fraunces', serif", marginBottom: 4 }}>
          ${WEEKLY_SALES.reduce((s, d) => s + d.revenue, 0).toLocaleString()}
        </div>
        <div style={{ fontSize: 12, color: "#2e7d32", fontWeight: 600, marginBottom: 16 }}>
          <Icon name="trendUp" size={13} /> +15% vs last week
        </div>
        <MiniBarChart data={WEEKLY_SALES} valueKey="revenue" labelKey="day" />
      </Card>
      <Card style={{ padding: 18 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#8a7e72", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 14 }}>Top Products (This Month)</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {TOP_PRODUCTS.map((p, i) => {
            const maxRev = TOP_PRODUCTS[0].revenue;
            return (
              <div key={i}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "#2c2416" }}>{p.product}</span>
                  <span style={{ fontSize: 12, fontWeight: 700, color: p.trend.startsWith("+") ? "#2e7d32" : "#e65100" }}>{p.trend}</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ flex: 1, height: 6, background: "#f0ebe4", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${(p.revenue / maxRev) * 100}%`, background: "linear-gradient(90deg, #2d5016, #4a7c28)", borderRadius: 3 }} />
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, color: "#5a5044", minWidth: 50, textAlign: "right" }}>${p.revenue}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
    {/* Market breakdown */}
    <Card style={{ padding: 18, marginTop: 14 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: "#8a7e72", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 14 }}>Revenue by Market</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12 }}>
        {[
          { name: "ABC Market", rev: 1240, pct: 38, orders: 18 },
          { name: "River Market", rev: 890, pct: 27, orders: 12 },
          { name: "Hillcrest Co-op", rev: 620, pct: 19, orders: 9 },
          { name: "Heights Corner", rev: 514, pct: 16, orders: 7 },
        ].map((m, i) => (
          <div key={i} style={{ textAlign: "center", padding: 14, background: "#faf8f5", borderRadius: 10 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: "#2c2416", fontFamily: "'Fraunces', serif" }}>${m.rev}</div>
            <div style={{ fontSize: 11, color: "#8a7e72", marginTop: 2 }}>{m.orders} orders</div>
            <div style={{ width: "100%", height: 4, background: "#e8e0d6", borderRadius: 2, marginTop: 8, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${m.pct}%`, background: "#4a7c28", borderRadius: 2 }} />
            </div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#2c2416", marginTop: 8 }}>{m.name}</div>
          </div>
        ))}
      </div>
    </Card>
  </div>
);

// ─── MULTI-FARM INVENTORY (MARKET VIEW) ─────────────────────────
const MultiFarmInventory = () => {
  const [filter, setFilter] = useState("all");
  const categories = ["all", ...new Set(INVENTORY.map(i => i.category))];
  const filtered = filter === "all" ? INVENTORY.filter(i => i.status !== "sold") : INVENTORY.filter(i => i.category === filter && i.status !== "sold");
  const byFarm = FARMS.map(f => ({ ...f, items: filtered.filter(i => i.farmId === f.id) })).filter(f => f.items.length > 0);

  return (
    <div>
      <SectionTitle action={
        <div style={{ display: "flex", gap: 4 }}>
          {categories.map(c => (
            <button key={c} onClick={() => setFilter(c)} style={{
              padding: "5px 12px", borderRadius: 16, border: "none", fontSize: 11, fontWeight: 600, cursor: "pointer",
              background: filter === c ? "#2d5016" : "#f0ebe4", color: filter === c ? "#fff" : "#5a5044",
              fontFamily: "'DM Sans', sans-serif", textTransform: "capitalize",
            }}>{c}</button>
          ))}
        </div>
      }>Browse All Farms</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {byFarm.map(farm => (
          <Card key={farm.id} style={{ overflow: "hidden" }}>
            <div style={{ padding: "12px 16px", background: "#faf8f5", borderBottom: "1px solid #f0ebe4", display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontSize: 20 }}>{farm.emoji}</span>
              <div>
                <div style={{ fontWeight: 700, fontSize: 13.5, color: "#2c2416" }}>{farm.name}</div>
                <div style={{ fontSize: 11, color: "#8a7e72" }}>{farm.location} · {farm.specialty}</div>
              </div>
              <div style={{ marginLeft: "auto", fontSize: 11, color: "#2d5016", fontWeight: 600 }}>{farm.items.length} items available</div>
            </div>
            <div style={{ padding: 8 }}>
              {farm.items.map(item => (
                <div key={item.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 10px", borderRadius: 8, transition: "background 0.15s" }}>
                  <span style={{ fontSize: 18, width: 28, textAlign: "center" }}>{EMOJI_MAP[item.category] || EMOJI_MAP.default}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, color: "#2c2416" }}>{item.product}</div>
                    <div style={{ fontSize: 11, color: "#8a7e72" }}>{item.remaining} {item.unit} · Harvested {item.harvestDate === "2026-03-21" ? "today" : item.harvestDate.slice(5)}</div>
                  </div>
                  <div style={{ fontWeight: 800, fontSize: 14, color: "#2d5016", marginRight: 8 }}>${item.price.toFixed(2)}<span style={{ fontSize: 10, fontWeight: 500, color: "#8a7e72" }}>/{item.unit}</span></div>
                  <Btn primary small>Order</Btn>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

// ─── ORDERS LIST ────────────────────────────────────────────────
const OrdersList = ({ perspective, farmFilter }) => {
  const items = perspective === "market"
    ? ORDERS.filter(o => o.marketId === "m1")
    : farmFilter ? ORDERS.filter(o => o.farmId === farmFilter) : ORDERS;
  return (
    <div>
      <SectionTitle action={<span style={{ fontSize: 12, color: "#2e7d32", fontWeight: 700, background: "#e8f5e9", padding: "4px 12px", borderRadius: 20 }}>
        Today: ${items.filter(o => o.date === "2026-03-21").reduce((s, o) => s + o.total, 0).toFixed(2)}
      </span>}>Orders</SectionTitle>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map(order => (
          <Card key={order.id} style={{ padding: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 34, height: 34, borderRadius: 8, background: "#f5f0ea", display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <Icon name={perspective === "market" ? "leaf" : "store"} size={15} />
                </div>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13, color: "#2c2416" }}>{perspective === "market" ? order.farm : order.market}</div>
                  <div style={{ fontSize: 11, color: "#8a7e72" }}>#{order.id.slice(1)} · {order.date} · {order.deliveryTime}</div>
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <StatusBadge status={order.status} />
                <span style={{
                  fontSize: 11, padding: "3px 8px", borderRadius: 10, fontWeight: 600,
                  background: order.delivery === "delivery" ? "#f3e5f5" : "#f5f0ea",
                  color: order.delivery === "delivery" ? "#7b1fa2" : "#5a5044",
                }}>
                  <Icon name={order.delivery === "delivery" ? "truck" : "store"} size={10} /> {order.delivery}
                </span>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 0 0", borderTop: "1px solid #f0ebe4" }}>
              <div style={{ fontSize: 12, color: "#5a5044" }}>
                {order.items.map(i => `${i.qty} ${i.unit} ${i.product}`).join(", ")}
              </div>
              <div style={{ fontWeight: 800, fontSize: 15, color: "#2d5016" }}>${order.total.toFixed(2)}</div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
};

// ─── FARMER INVENTORY ───────────────────────────────────────────
const FarmerInventory = () => (
  <div>
    <SectionTitle action={<Btn primary small>+ Add Harvest</Btn>}>Current Inventory</SectionTitle>
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {INVENTORY.filter(i => i.farmId === "f1").map(item => (
        <Card key={item.id} style={{ padding: 14, display: "flex", alignItems: "center", gap: 14 }}>
          <div style={{ width: 42, height: 42, borderRadius: 10, background: item.status === "sold" ? "#eee" : "#e8f5e9", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
            {EMOJI_MAP[item.category] || EMOJI_MAP.default}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, fontSize: 13.5, color: "#2c2416" }}>{item.product}</div>
            <div style={{ fontSize: 12, color: "#8a7e72", marginTop: 2 }}>
              {item.remaining}/{item.qty} {item.unit} remaining · {item.harvestDate === "2026-03-21" ? "Today" : item.harvestDate}
            </div>
            {item.remaining > 0 && item.remaining < item.qty && (
              <div style={{ marginTop: 4, height: 4, background: "#f0ebe4", borderRadius: 2, overflow: "hidden", width: 120 }}>
                <div style={{ height: "100%", width: `${(item.remaining / item.qty) * 100}%`, background: item.remaining / item.qty < 0.3 ? "#e65100" : "#4a7c28", borderRadius: 2 }} />
              </div>
            )}
          </div>
          <div style={{ textAlign: "right", flexShrink: 0 }}>
            <div style={{ fontWeight: 800, fontSize: 15, color: "#2d5016" }}>${item.price.toFixed(2)}<span style={{ fontSize: 10, fontWeight: 500, color: "#8a7e72" }}>/{item.unit}</span></div>
            <div style={{ marginTop: 4 }}><StatusBadge status={item.status} /></div>
          </div>
          <div style={{ flexShrink: 0, color: "#c0b8ae", cursor: "pointer", padding: 4 }}><Icon name="edit" size={15} /></div>
        </Card>
      ))}
    </div>
  </div>
);

// ─── FARMER MARKETS MANAGEMENT ──────────────────────────────────
const FarmerMarkets = () => (
  <div>
    <SectionTitle action={<Btn primary small>+ Add Market</Btn>}>My Markets</SectionTitle>
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {MARKETS.map((m, idx) => (
        <Card key={m.id} style={{ padding: 14, display: "flex", alignItems: "center", gap: 14, opacity: m.active ? 1 : 0.5 }}>
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0, flexShrink: 0, width: 24 }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: "#2d5016", fontFamily: "'Fraunces', serif" }}>{m.priority}</span>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontWeight: 700, fontSize: 13.5, color: "#2c2416" }}>{m.name}</span>
              <span style={{ fontSize: 10, padding: "2px 7px", borderRadius: 10, background: "#f0ebe4", color: "#5a5044", fontWeight: 600 }}>{m.type}</span>
            </div>
            <div style={{ fontSize: 12, color: "#8a7e72", marginTop: 2 }}>
              {m.contact} · Prefers {m.deliveryPref}
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: m.active ? "#2e7d32" : "#8a7e72" }}>{m.active ? "Active" : "Paused"}</span>
            <div style={{
              width: 36, height: 20, borderRadius: 10, cursor: "pointer",
              background: m.active ? "#4a7c28" : "#d0c8be", position: "relative",
            }}>
              <div style={{
                width: 16, height: 16, borderRadius: "50%", background: "#fff", position: "absolute", top: 2,
                left: m.active ? 18 : 2, boxShadow: "0 1px 3px rgba(0,0,0,0.15)", transition: "left 0.2s",
              }} />
            </div>
          </div>
        </Card>
      ))}
    </div>
  </div>
);

// ─── MAIN APP ───────────────────────────────────────────────────
export default function FarmLink() {
  const [view, setView] = useState("home");
  const [farmerTab, setFarmerTab] = useState("inventory");
  const [marketTab, setMarketTab] = useState("browse");

  const todayOrders = ORDERS.filter(o => o.date === "2026-03-21");
  const todayRevenue = todayOrders.reduce((s, o) => s + o.total, 0);

  const navItems = [
    { id: "home", label: "Overview" },
    { id: "farmer-sms", label: "📱 Farmer SMS" },
    { id: "market-sms", label: "📱 Market SMS" },
    { id: "farmer-dash", label: "🌱 Farmer" },
    { id: "market-dash", label: "🏪 Market" },
  ];

  return (
    <div style={{ fontFamily: "'DM Sans', sans-serif", minHeight: "100vh", background: "#faf8f5" }}>
      {FONTS}
      <style>{`
        @keyframes fadeSlide { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes bounce { 0%, 80%, 100% { transform: translateY(0); } 40% { transform: translateY(-5px); } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-thumb { background: #d0c8be; border-radius: 3px; }
      `}</style>

      {/* HEADER */}
      <div style={{ background: "linear-gradient(135deg, #1a3409, #2d5016 40%, #4a7c28)", position: "sticky", top: 0, zIndex: 100 }}>
        <div style={{ maxWidth: 1140, margin: "0 auto", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 9, background: "rgba(255,255,255,0.13)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <Icon name="leaf" size={20} />
            </div>
            <div>
              <div style={{ color: "#fff", fontSize: 19, fontWeight: 800, fontFamily: "'Fraunces', serif", letterSpacing: -0.5 }}>FarmLink</div>
              <div style={{ color: "rgba(255,255,255,0.5)", fontSize: 10, letterSpacing: 0.8, textTransform: "uppercase" }}>Farm to Market · Text-First</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 3 }}>
            {navItems.map(n => (
              <button key={n.id} onClick={() => setView(n.id)} style={{
                background: view === n.id ? "rgba(255,255,255,0.18)" : "transparent",
                border: "1px solid " + (view === n.id ? "rgba(255,255,255,0.25)" : "transparent"),
                color: "#fff", padding: "6px 13px", borderRadius: 7, fontSize: 11.5, fontWeight: 600,
                cursor: "pointer", fontFamily: "'DM Sans', sans-serif", transition: "all 0.15s",
              }}>{n.label}</button>
            ))}
          </div>
        </div>
      </div>

      <div style={{ maxWidth: 1140, margin: "0 auto", padding: "20px 24px" }}>
        {/* ── HOME ─────────────────────────────────────────────── */}
        {view === "home" && (
          <div style={{ animation: "fadeIn 0.25s ease" }}>
            {/* Stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 10, marginBottom: 20 }}>
              {[
                { label: "Today's Revenue", value: `$${todayRevenue.toFixed(0)}`, icon: "dollar", c: "#2e7d32" },
                { label: "Active Orders", value: todayOrders.length, icon: "cart", c: "#e65100" },
                { label: "Items Listed", value: INVENTORY.filter(i => i.status !== "sold").length, icon: "package", c: "#1565c0" },
                { label: "Connected Farms", value: FARMS.length, icon: "leaf", c: "#4a7c28" },
                { label: "Standing Orders", value: RECURRING_ORDERS.filter(r => r.active).length, icon: "repeat", c: "#7b1fa2" },
              ].map((s, i) => (
                <Card key={i} style={{ padding: "14px 16px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                    <div style={{ color: s.c, opacity: 0.7 }}><Icon name={s.icon} size={14} /></div>
                    <span style={{ fontSize: 10, color: "#8a7e72", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4 }}>{s.label}</span>
                  </div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: "#2c2416", fontFamily: "'Fraunces', serif" }}>{s.value}</div>
                </Card>
              ))}
            </div>

            {/* Two columns: SMS demos */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 20 }}>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <h3 style={{ margin: 0, fontFamily: "'Fraunces', serif", fontWeight: 700, color: "#2c2416", fontSize: 15 }}>Farmer SMS — Smart Assistant</h3>
                  <button onClick={() => setView("farmer-sms")} style={{ background: "none", border: "none", color: "#2d5016", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 3 }}>Full Demo <Icon name="arrow" size={12} /></button>
                </div>
                <div style={{ height: 440 }}><SMSChat script={FARMER_SMS} userRole="farmer" title="Green Acres Farm" /></div>
              </div>
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <h3 style={{ margin: 0, fontFamily: "'Fraunces', serif", fontWeight: 700, color: "#2c2416", fontSize: 15 }}>Market SMS — Multi-Farm View</h3>
                  <button onClick={() => setView("market-sms")} style={{ background: "none", border: "none", color: "#2d5016", fontSize: 11, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 3 }}>Full Demo <Icon name="arrow" size={12} /></button>
                </div>
                <div style={{ height: 440 }}><SMSChat script={MARKET_SMS} userRole="market" title="ABC Market" subtitle="Buying from 3 farms" /></div>
              </div>
            </div>

            {/* Delivery + Features */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
              <Card style={{ padding: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#8a7e72", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 14 }}>Today's Delivery Schedule</div>
                <DeliveryTimeline />
              </Card>
              <Card style={{ padding: 20 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#8a7e72", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 14 }}>Platform Features</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                  {[
                    { icon: "msg", title: "Text-First", desc: "Natural language SMS for all core actions" },
                    { icon: "bell", title: "Smart Alerts", desc: "Proactive suggestions and reminders" },
                    { icon: "users", title: "Multi-Farm", desc: "Markets browse across all connected farms" },
                    { icon: "truck", title: "Logistics", desc: "Delivery scheduling and route coordination" },
                    { icon: "repeat", title: "Standing Orders", desc: "Recurring orders with auto-fulfillment" },
                    { icon: "chart", title: "Analytics", desc: "Sales trends, top sellers, market insights" },
                  ].map((f, i) => (
                    <div key={i} style={{ padding: 12, background: "#faf8f5", borderRadius: 8 }}>
                      <div style={{ color: "#4a7c28", marginBottom: 6 }}><Icon name={f.icon} size={16} /></div>
                      <div style={{ fontWeight: 700, fontSize: 12, color: "#2c2416", marginBottom: 3 }}>{f.title}</div>
                      <div style={{ fontSize: 11, color: "#8a7e72", lineHeight: 1.4 }}>{f.desc}</div>
                    </div>
                  ))}
                </div>
              </Card>
            </div>
          </div>
        )}

        {/* ── FARMER SMS ───────────────────────────────────────── */}
        {view === "farmer-sms" && (
          <div style={{ maxWidth: 440, margin: "0 auto", height: 620, animation: "fadeIn 0.25s ease" }}>
            <SMSChat script={FARMER_SMS} userRole="farmer" title="Green Acres Farm" subtitle="Smart assistant with proactive suggestions" />
          </div>
        )}

        {/* ── MARKET SMS ───────────────────────────────────────── */}
        {view === "market-sms" && (
          <div style={{ maxWidth: 440, margin: "0 auto", height: 620, animation: "fadeIn 0.25s ease" }}>
            <SMSChat script={MARKET_SMS} userRole="market" title="ABC Market" subtitle="Connected to 3 farms" />
          </div>
        )}

        {/* ── FARMER DASHBOARD ─────────────────────────────────── */}
        {view === "farmer-dash" && (
          <div style={{ animation: "fadeIn 0.25s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 style={{ margin: 0, fontFamily: "'Fraunces', serif", fontWeight: 800, color: "#2c2416", fontSize: 20 }}>🌱 Green Acres Farm</h2>
              <TabBar active={farmerTab} onNav={setFarmerTab} items={[
                { id: "inventory", icon: "package", label: "Inventory", badge: INVENTORY.filter(i => i.farmId === "f1" && i.status !== "sold").length },
                { id: "orders", icon: "cart", label: "Orders", badge: ORDERS.filter(o => o.farmId === "f1" && o.status === "pending").length },
                { id: "delivery", icon: "truck", label: "Deliveries", badge: 0 },
                { id: "recurring", icon: "repeat", label: "Standing", badge: RECURRING_ORDERS.filter(r => r.active).length },
                { id: "markets", icon: "store", label: "Markets", badge: 0 },
                { id: "analytics", icon: "chart", label: "Analytics", badge: 0 },
              ]} />
            </div>
            {/* Quick stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
              {[
                { label: "Today", value: `$${todayRevenue.toFixed(0)}` },
                { label: "This Week", value: `$${WEEKLY_SALES.reduce((s, d) => s + d.revenue, 0).toLocaleString()}` },
                { label: "Pending", value: ORDERS.filter(o => o.status === "pending").length },
                { label: "Items Active", value: INVENTORY.filter(i => i.farmId === "f1" && i.status !== "sold").length },
              ].map((s, i) => (
                <Card key={i} style={{ padding: "12px 16px" }}>
                  <div style={{ fontSize: 10, color: "#8a7e72", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>{s.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "#2c2416", fontFamily: "'Fraunces', serif" }}>{s.value}</div>
                </Card>
              ))}
            </div>
            {farmerTab === "inventory" && <FarmerInventory />}
            {farmerTab === "orders" && <OrdersList perspective="farmer" farmFilter="f1" />}
            {farmerTab === "delivery" && (
              <Card style={{ padding: 20 }}>
                <SectionTitle>Today's Schedule</SectionTitle>
                <DeliveryTimeline />
              </Card>
            )}
            {farmerTab === "recurring" && <RecurringOrders perspective="farmer" />}
            {farmerTab === "markets" && <FarmerMarkets />}
            {farmerTab === "analytics" && <Analytics />}
          </div>
        )}

        {/* ── MARKET DASHBOARD ─────────────────────────────────── */}
        {view === "market-dash" && (
          <div style={{ animation: "fadeIn 0.25s ease" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
              <h2 style={{ margin: 0, fontFamily: "'Fraunces', serif", fontWeight: 800, color: "#2c2416", fontSize: 20 }}>🏪 ABC Market</h2>
              <TabBar active={marketTab} onNav={setMarketTab} items={[
                { id: "browse", icon: "grid", label: "Browse Farms", badge: 0 },
                { id: "orders", icon: "cart", label: "My Orders", badge: 1 },
                { id: "recurring", icon: "repeat", label: "Standing Orders", badge: 0 },
                { id: "schedule", icon: "truck", label: "Deliveries", badge: 0 },
              ]} />
            </div>
            {/* Market stats */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 18 }}>
              {[
                { label: "Pending Orders", value: "1" },
                { label: "This Week", value: "$283" },
                { label: "Connected Farms", value: "3" },
                { label: "Standing Orders", value: "3" },
              ].map((s, i) => (
                <Card key={i} style={{ padding: "12px 16px" }}>
                  <div style={{ fontSize: 10, color: "#8a7e72", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.4, marginBottom: 3 }}>{s.label}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, color: "#2c2416", fontFamily: "'Fraunces', serif" }}>{s.value}</div>
                </Card>
              ))}
            </div>
            {marketTab === "browse" && <MultiFarmInventory />}
            {marketTab === "orders" && <OrdersList perspective="market" />}
            {marketTab === "recurring" && <RecurringOrders perspective="market" />}
            {marketTab === "schedule" && (
              <Card style={{ padding: 20 }}>
                <SectionTitle>Incoming Deliveries & Pickups</SectionTitle>
                <DeliveryTimeline />
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
