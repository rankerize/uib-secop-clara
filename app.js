// ==============================================================
// UIB REINSURANCE HUB - V3.2 (FINAL STABLE + TECH EXTRACTION)
// ==============================================================

const firebaseConfig = {
    apiKey: "AIzaSyCuHa53yxUUCAF4j6KCp9yyJXKyqN8STZs",
    authDomain: "oportunidades-uib-colombia.firebaseapp.com",
    projectId: "oportunidades-uib-colombia",
    storageBucket: "oportunidades-uib-colombia.firebasestorage.app",
    messagingSenderId: "222251386094",
    appId: "1:222251386094:web:d44feedfb61d3ce9301fff"
};

// 1. SAFE FIREBASE INIT
try {
    if (typeof firebase !== 'undefined') {
        if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
        window.db = firebase.firestore();
    }
} catch (e) { console.warn("Firebase limited mode", e); }

// 2. CONFIG & TREE
const PROCESOS_API = "https://www.datos.gov.co/resource/p6dx-8zbt.json";
const CONTRATOS_API = "https://www.datos.gov.co/resource/jbjy-vk9h.json";
const SECOP1_API = "https://www.datos.gov.co/resource/f789-7hwg.json";
const BACKEND_URL = "http://localhost:8000/analyze"; 

const CLUSTER_TREE = [
    {
        id: "seguros", label: "🛡️ Seguros & Reaseguros", icon: "🛡️",
        subs: [
            { id: "seguros-aereo", label: "Aviación & Casco", terms: ["seguro aviacion", "casco aeronave", "seguro aereo"] },
            { id: "seguros-rc", label: "Responsabilidad Civil", terms: ["responsabilidad civil", "seguro rc"] },
            { id: "seguros-bienes", label: "Todo Riesgo Bienes", terms: ["todo riesgo", "poliza todo riesgo"] },
            { id: "seguros-vida", label: "Vida & Salud", terms: ["seguro de vida", "seguro salud"] },
            { id: "seguros-generales", label: "Pólizas Generales", terms: ["poliza", "seguros", "amparo"] }
        ]
    },
    {
        id: "aviacion", label: "✈️ Aviación & Aeropuertos", icon: "✈️",
        subs: [
            { id: "aviacion-aerocivil", label: "Aeronáutica Civil", terms: ["aerocivil", "aeronautica civil"] },
            { id: "aviacion-aeropuertos", label: "Aeropuertos", terms: ["aeropuerto", "terminal aerea"] },
            { id: "aviacion-operacion", label: "Operación & Aeronaves", terms: ["aviacion", "aeronave", "vuelo"] }
        ]
    },
    {
        id: "infra", label: "🏗️ Infraestructura", icon: "🏗️",
        subs: [
            { id: "infra-obras", label: "Obras Civiles", terms: ["obra civil", "construccion", "infraestructura"] },
            { id: "infra-vias", label: "Vías & Puentes", terms: ["pavimentacion", "via vial", "puente"] }
        ]
    }
];

let globalTenders = [];
let currentSubId = null;
const clusterCache = {};

// 3. UTILS
async function fetchWithTimeout(url, timeout = 15000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return response;
}

function getTs(t) {
    const d = t.fecha_de_publicacion_del || t.fecha_de_ultima_publicaci || t.ultima_actualizacion || t.fecha_de_firma || 0;
    return new Date(d).getTime();
}

function formatMoney(v) { return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP' }).format(v || 0); }

function isActive(t) {
    const s = (t.estado_del_procedimiento || t.estado_del_proceso || t.estado_contrato || "").toLowerCase();
    return !(s.includes("cerrado") || s.includes("terminado") || s.includes("liquidado"));
}

// 4. CORE ENGINE
async function loadSubCluster(sub) {
    const loader = document.getElementById('radar-loader');
    const status = document.getElementById('load-status');
    const grid = document.getElementById('radar-grid');
    const title = document.getElementById('radar-title');
    const count = document.getElementById('radar-count');

    if (title) title.textContent = sub.label;
    currentSubId = sub.id;

    if (sub.type === "external") {
        if (loader) loader.classList.add('hidden');
        if (grid) grid.innerHTML = `<div class="radar-card external-card"><h3>${sub.label}</h3><p>${sub.desc}</p><a href="${sub.url}" target="_blank" class="primary-btn">Ir al Portal</a></div>`;
        if (count) count.textContent = "1";
        return;
    }

    if (clusterCache[sub.id]) {
        globalTenders = clusterCache[sub.id];
        applyRadarFilters();
        if (loader) loader.classList.add('hidden');
        return;
    }

    try {
        if (loader) loader.classList.remove('hidden');
        const map = new Map();
        for (const term of sub.terms) {
            if (status) status.textContent = `Escaneando: "${term}"...`;
            const results = await Promise.allSettled([
                fetchWithTimeout(`${PROCESOS_API}?$q=${encodeURIComponent(term)}&$limit=500`).then(r => r.json()),
                fetchWithTimeout(`${CONTRATOS_API}?$q=${encodeURIComponent(term)}&$limit=500`).then(r => r.json()),
                fetchWithTimeout(`${SECOP1_API}?$q=${encodeURIComponent(term)}&$limit=500`).then(r => r.json())
            ]);
            results.forEach((res, idx) => {
                if (res.status === 'fulfilled' && Array.isArray(res.value)) {
                    res.value.forEach(item => {
                        const id = item.id_del_proceso || item.id_contrato || item.numero_de_proceso || Math.random();
                        item._source = idx === 0 ? "Proceso II" : idx === 1 ? "Contrato II" : "SECOP I";
                        if (!map.has(id)) map.set(id, item);
                    });
                }
            });
            globalTenders = Array.from(map.values()).sort((a,b) => getTs(b) - getTs(a));
            applyRadarFilters();
        }
        clusterCache[sub.id] = globalTenders;
        if (loader) loader.classList.add('hidden');
    } catch (e) { console.error(e); }
}

function applyRadarFilters() {
    const searchTerm = (document.getElementById('radar-search')?.value || "").toLowerCase();
    const entityTerm = (document.getElementById('radar-entity')?.value || "").toLowerCase();
    const typeTerm = (document.getElementById('radar-business-type')?.value || "").toLowerCase();
    const statusFilter = document.getElementById('radar-status')?.value || "Activo";
    const timeFilter = document.getElementById('radar-time')?.value || "180D";
    const valueFilter = document.getElementById('radar-value')?.value || "ALL";
    const sortFilter = document.getElementById('radar-sort')?.value || "date-desc";

    const now = Date.now();
    const timeLimits = { "30D": 30, "180D": 180, "1Y": 365 };

    const filtered = globalTenders.filter(t => {
        const txt = (t.objeto_del_procedimiento || t.objeto_del_contrato || t.objeto_del_proceso || "").toLowerCase();
        if (searchTerm && !txt.includes(searchTerm)) return false;

        const ent = (t.entidad || t.nombre_entidad || "").toLowerCase();
        if (entityTerm && !ent.includes(entityTerm)) return false;

        const type = (t.tipo_de_contrato || t.modalidad_de_contratacion || "").toLowerCase();
        if (typeTerm && !type.includes(typeTerm)) return false;

        const act = isActive(t);
        if (statusFilter === "Activo" && !act) return false;
        if (statusFilter === "Cerrados" && act) return false;

        if (timeFilter !== "ALL") {
            const days = timeLimits[timeFilter];
            if (days && (now - getTs(t)) / (1000 * 3600 * 24) > days) return false;
        }

        const amt = parseFloat(t.precio_base || t.valor_estimado || t.valor_del_contrato || 0);
        if (valueFilter === "LT_1B" && amt >= 1e9) return false;
        if (valueFilter === "1B_10B" && (amt < 1e9 || amt > 10e9)) return false;
        if (valueFilter === "10B_50B" && (amt < 10e9 || amt > 50e9)) return false;
        if (valueFilter === "GT_50B" && amt <= 50e9) return false;

        return true;
    });

    filtered.sort((a, b) => {
        if (sortFilter === "value-desc") {
            const vA = parseFloat(a.precio_base || a.valor_estimado || a.valor_del_contrato || 0);
            const vB = parseFloat(b.precio_base || b.valor_estimado || b.valor_del_contrato || 0);
            return vB - vA;
        }
        return getTs(b) - getTs(a);
    });

    renderRadar(filtered);
}

function renderRadar(tenders) {
    const grid = document.getElementById('radar-grid');
    const count = document.getElementById('radar-count');
    if (!grid) return;
    if (count) count.textContent = tenders.length;
    grid.innerHTML = "";
    tenders.forEach(t => {
        const ent = t.entidad || t.nombre_entidad || "Entidad";
        const obj = t.objeto_del_procedimiento || t.objeto_del_contrato || t.objeto_del_proceso || "";
        const act = isActive(t);
        const amt = parseFloat(t.precio_base || t.valor_estimado || t.valor_del_contrato || 0);
        let link = t.urlproceso || t.url_proceso || t.ruta_proceso_en_secop_i || "";
        if (typeof link === 'object') link = link.url;

        const card = document.createElement('div');
        card.className = "radar-card";
        card.innerHTML = `
            <div>
                <span class="rc-stat ${act ? 'activo' : 'cerrado'}">${t._source}</span>
                <div class="rc-ent">${ent}</div>
                <div class="rc-val">💰 ${formatMoney(amt)}</div>
                <div class="rc-desc">${obj.substring(0, 180)}...</div>
            </div>
            <div class="rc-bot">
                ${link ? `<a href="${link}" target="_blank" class="btn-sm btn-sec">Ver SECOP</a>` : ''}
                <button class="btn-sm btn-ai send-ai-btn">🧠 Analizar IA</button>
            </div>
        `;
        card.querySelector('.send-ai-btn').addEventListener('click', () => {
            const emailField = document.getElementById('email-text');
            const urlField = document.getElementById('secop-url');
            if (emailField) emailField.value = `Entidad: ${ent}\nObjeto: ${obj}\nPresupuesto: ${formatMoney(amt)}`;
            if (urlField) urlField.value = typeof link === 'string' ? link : "";
            switchTab('tab-ai');
            setTimeout(validateForm, 100);
        });
        grid.appendChild(card);
    });
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === tabId));
}

function validateForm() {
    const emailText = document.getElementById('email-text');
    const secopUrl = document.getElementById('secop-url');
    const analyzeBtn = document.getElementById('analyze-btn');
    if (emailText && secopUrl && analyzeBtn) {
        const isValid = emailText.value.trim().length > 10 && secopUrl.value.trim().length > 5;
        analyzeBtn.disabled = !isValid;
    }
}

async function startAIAnalysis() {
    const emailText = document.getElementById('email-text').value;
    const secopUrl = document.getElementById('secop-url').value;
    const loader = document.getElementById('loader');
    const resultCont = document.getElementById('result-content');
    const container = document.getElementById('results-container');

    container.classList.remove('hidden');
    loader.classList.remove('hidden');
    resultCont.classList.add('hidden');

    const formData = new FormData();
    formData.append('emailText', emailText);
    formData.append('secopUrl', secopUrl);

    try {
        const response = await fetch(BACKEND_URL, { method: 'POST', body: formData });
        if (!response.ok) throw new Error("Error en servidor de IA");
        const data = await response.json();
        if (data.error) throw new Error(data.error);

        // UI Updates
        document.getElementById('resumen-empresa').textContent = data.resumen_empresa || "N/A";
        document.getElementById('investigacion-inicial').textContent = data.investigacion_inicial || "N/A";

        // Technical Section
        const ct = data.condiciones_tecnicas || {};
        document.getElementById('tech-objeto').textContent = ct.objeto_seguro || "No detectado";
        document.getElementById('tech-deducibles').textContent = ct.deducibles || "No especificado";
        document.getElementById('tech-vigencia').textContent = ct.vigencia || "No especificada";
        
        const amparosEl = document.getElementById('tech-amparos');
        amparosEl.innerHTML = "";
        (ct.amparos || []).forEach(a => {
            const span = document.createElement('span');
            span.className = "tech-tag";
            span.textContent = a;
            amparosEl.appendChild(span);
        });

        // Values
        const valsEl = document.getElementById('valores-seguros');
        valsEl.innerHTML = "";
        (data.valores_seguros || []).forEach(v => {
            const card = document.createElement('div');
            card.className = "insurance-card";
            card.innerHTML = `<strong>${v.tipo_seguro}</strong><div>${v.valor}</div><small>${v.detalles}</small>`;
            valsEl.appendChild(card);
        });

        // Risks
        const risksEl = document.getElementById('analisis-riesgos');
        risksEl.innerHTML = "";
        (data.analisis_riesgos || []).forEach(r => {
            const li = document.createElement('li');
            li.textContent = r;
            risksEl.appendChild(li);
        });

        loader.classList.add('hidden');
        resultCont.classList.remove('hidden');
    } catch (e) {
        alert("Error: " + e.message);
        container.classList.add('hidden');
    }
}

// 5. MASTER START
document.addEventListener('DOMContentLoaded', () => {
    const emailText = document.getElementById('email-text');
    const secopUrl = document.getElementById('secop-url');
    const analyzeBtn = document.getElementById('analyze-btn');

    ['radar-search', 'radar-entity', 'radar-business-type'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', applyRadarFilters);
    });
    ['radar-status', 'radar-time', 'radar-value', 'radar-sort'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('change', applyRadarFilters);
    });

    document.querySelectorAll('.tab-btn').forEach(btn => btn.addEventListener('click', () => switchTab(btn.dataset.tab)));
    if (emailText) emailText.addEventListener('input', validateForm);
    if (secopUrl) secopUrl.addEventListener('input', validateForm);
    if (analyzeBtn) analyzeBtn.addEventListener('click', startAIAnalysis);

    const sectorStrip = document.getElementById('sector-strip');
    const subgroupStrip = document.getElementById('subgroup-strip');

    function renderSubs(group) {
        subgroupStrip.innerHTML = "";
        group.subs.forEach(s => {
            const b = document.createElement('button');
            b.className = 'csub-btn';
            b.textContent = s.label;
            b.addEventListener('click', () => {
                document.querySelectorAll('.csub-btn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
                loadSubCluster(s);
            });
            subgroupStrip.appendChild(b);
        });
    }

    CLUSTER_TREE.forEach(g => {
        const b = document.createElement('button');
        b.className = 'sector-btn';
        b.innerHTML = `<span class="icon">${g.icon}</span><span>${g.label}</span>`;
        b.addEventListener('click', () => {
            document.querySelectorAll('.sector-btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            renderSubs(g);
            loadSubCluster(g.subs[0]);
        });
        sectorStrip.appendChild(b);
    });

    const firstGroup = CLUSTER_TREE[0];
    sectorStrip.querySelector('.sector-btn')?.classList.add('active');
    renderSubs(firstGroup);
    setTimeout(() => loadSubCluster(firstGroup.subs[0]), 500);
});
