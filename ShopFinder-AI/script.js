import { GoogleGenerativeAI } from "@google/generative-ai";
import { GEMINI_API_KEY, MAPBOX_TOKEN, APP_CONFIG } from "./config.js";

// Inicializa a IA
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: APP_CONFIG.modelName });

let analysisHistory = [];
let map = null;

const uploadSection = document.getElementById('upload-section');
const resultsSection = document.getElementById('results-section');
const fileInput = document.getElementById('file-upload');
const btnSelect = document.getElementById('btn-select');
const dropZone = document.getElementById('drop-zone');
const loader = document.getElementById('loader');

const elements = {
    img: document.getElementById('res-img'),
    name: document.getElementById('res-name'),
    category: document.getElementById('res-category'),
    tags: document.getElementById('res-tags'),
    features: document.getElementById('res-features'),
    style: document.getElementById('res-style'),
    desc: document.getElementById('res-desc'),
    nearby: document.getElementById('res-nearby'),
    nearbyCard: document.getElementById('nearby-card'),
    historyList: document.getElementById('history-list')
};

const categoryMap = {
    'restaurante': 'restaurant',
    'lanchonete': 'fast_food',
    'hamburgueria': 'fast_food',
    'pizza': 'restaurant',
    'bar': 'bar',
    'café': 'cafe', 
    'cafeteria': 'cafe',
    'padaria': 'bakery',
    'confeitaria': 'confectionery', 
    'doce': 'confectionery',        
    'festas': 'shop',               
    'artigos': 'shop',
    'varejo': 'shop',
    'loja': 'shop',
    'mercado': 'grocery', 
    'supermercado': 'grocery',
    'farmácia': 'pharmacy',
    'hotel': 'hotel',
    'posto': 'gas_station'
};

const termosGenericos = [
  'restaurante', 'lanchonete', 'bar', 'loja', 'mercado', 'supermercado', 
  'farmácia', 'padaria', 'comércio', 'estabelecimento', 'local', 'empresa'
];

btnSelect.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
dropZone.addEventListener('click', (e) => { if (!e.target.closest('.loader-overlay')) fileInput.click(); });
fileInput.addEventListener('change', (e) => { if(e.target.files.length) handleProcess(e.target.files[0]); });

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', (e) => { e.preventDefault(); if (e.target === dropZone) dropZone.classList.remove('dragging'); });
dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragging');
    if(e.dataTransfer.files.length) handleProcess(e.dataTransfer.files[0]);
});

async function handleProcess(file) {
    if (!validateFile(file)) return;

    if (!GEMINI_API_KEY || GEMINI_API_KEY.includes("SUA_CHAVE") || GEMINI_API_KEY.length < 30) {
        alert("⚠️ ATENÇÃO: Configure sua GEMINI_API_KEY no arquivo config.js");
        return;
    }

    const objectUrl = URL.createObjectURL(file);
    elements.img.src = objectUrl;
    loader.classList.remove('hidden');
    btnSelect.disabled = true;

    try {
        // PASSO 1: Geolocalização do Usuário
        const userLocation = await getUserLocation();
        console.log("📍 [1] Localização do Usuário:", userLocation);
        
        // PASSO 2: Análise com Gemini
        const base64Image = await fileToGenerativePart(file);
        const geminiData = await analyzeWithGemini(base64Image);
        console.log("🤖 [2] Dados Gemini:", geminiData);
        
        // PASSO 3: Extract Location Data
        const locationQuery = buildLocationQuery(geminiData);
        console.log("🔍 [3] Query de Localização:", locationQuery);
        
        // PASSO 4: Geocoding
        const geocodedLocation = await geocodeLocation(locationQuery);
        console.log("🗺️ [4] Localização Geocodificada:", geocodedLocation);
        
        // PASSO 5: Merge de coordenadas
        const finalCoordinates = geocodedLocation || userLocation;
        console.log("📍 [5] Coordenadas Finais:", finalCoordinates);
        
        // PASSO 6: Search Parameters (Decide TEXT ou CATEGORY)
        const searchParams = buildSearchParameters(geminiData);
        console.log("⚙️ [6] Parâmetros de Busca:", searchParams);
        
        // PASSO 7: Busca no Mapbox
        let nearbyPlaces;
        if (searchParams.search_type === 'text') {
            console.log("📝 [7a] Buscando por TEXTO:", searchParams.search_query);
            nearbyPlaces = await searchByText(searchParams.search_query, finalCoordinates);
        } else {
            console.log("🏪 [7b] Buscando por CATEGORIA:", searchParams.mapbox_category);
            nearbyPlaces = await searchByCategory(searchParams.mapbox_category, finalCoordinates);
        }
        
        // PASSO 8: Format Nearby Results (Filtra e formata)
        const formattedPlaces = formatNearbyResults(nearbyPlaces, geminiData, searchParams, finalCoordinates, userLocation);
        console.log("✅ [8] Locais Formatados:", formattedPlaces);
        
        // PASSO 9: Consolidar dados finais
        const fullData = { 
            ...geminiData, 
            coordinates: finalCoordinates,
            user_location: userLocation,
            locais_proximos: formattedPlaces 
        };

        addToHistory(fullData, objectUrl);
        showResults(fullData);

    } catch (error) {
        console.error("❌ Erro no processo:", error);
        alert(`❌ Erro: ${error.message}`);
        URL.revokeObjectURL(objectUrl);
    } finally {
        loader.classList.add('hidden');
        btnSelect.disabled = false;
        fileInput.value = '';
    }
}

function validateFile(file) {
    if (file.size > APP_CONFIG.maxFileSize) { 
        alert('Arquivo muito grande! Máximo permitido: 10MB'); 
        return false; 
    }
    if (!file.type.startsWith('image/')) { 
        alert('Por favor, envie apenas imagens.'); 
        return false; 
    }
    return true;
}

function fileToGenerativePart(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve({ 
            inlineData: { 
                data: reader.result.split(',')[1], 
                mimeType: file.type 
            } 
        });
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function analyzeWithGemini(imagePart) {
    const prompt = `Objetivo: Analise a imagem fornecida e retorne apenas um objeto JSON válido, sem nenhum outro texto antes ou depois.

Instruções:

Você é um assistente de IA que atua como uma API. Sua resposta deve ser um JSON formatado (mime type application/json).

Analise a imagem para identificar o estabelecimento principal.

Tente identificar qualquer texto na imagem que indique uma localização (nome da rua, cidade, placa de endereço).

Gere uma lista de tags descritivas, estilo e uma descrição detalhada.

Esquema JSON de Saída Obrigatório:

{
  "estabelecimento": "Nome principal do local na imagem",
  "categoria": "Tipo de estabelecimento (ex: Restaurante, Supermercado, Farmácia)",
  "tags": [
    "tag visual 1",
    "tag conceitual 2",
    "tag de cor 3"
  ],
  "estilo": "Descrição do estilo e ambiente (ex: Moderno, Casual, Varejo)",
  "descricao": "Descrição detalhada do que é visto na imagem (objetos, arquitetura, cores)",
  "localizacao_texto": "Qualquer texto de endereço, rua ou cidade visível na imagem. Se nada for encontrado, retorne null."
}`;

    try {
        const result = await model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const text = response.text();
        const jsonString = text.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonString);
    } catch (e) {
        console.error("Erro Gemini:", e);
        throw new Error("Falha ao analisar imagem com a IA.");
    }
}

// Extract Location Data 
function buildLocationQuery(geminiData) {
    let locationQuery = "";
    let hasLocation = false;

    if (geminiData.localizacao_texto && geminiData.localizacao_texto !== null) {
        locationQuery = geminiData.localizacao_texto;
        hasLocation = true;
    } else if (geminiData.estabelecimento && geminiData.estabelecimento !== "Estabelecimento Não Identificado") {
        locationQuery = geminiData.estabelecimento + " Uberlândia MG";
        hasLocation = true;
    }

    if (!hasLocation || !locationQuery) {
        locationQuery = "Uberlândia, Minas Gerais, Brasil";
    }

    return locationQuery;
}

// Geocoding
async function geocodeLocation(locationQuery) {
    const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(locationQuery)}.json?` +
        `access_token=${MAPBOX_TOKEN}` +
        `&limit=1` +
        `&language=pt` +
        `&country=BR`;

    try {
        const response = await fetch(url);
        if (!response.ok) return null;
        
        const data = await response.json();
        
        if (data.features && data.features.length > 0) {
            const feature = data.features[0];
            return {
                longitude: feature.center[0],
                latitude: feature.center[1],
                place_name: feature.place_name
            };
        }
        return null;
    } catch (error) {
        console.warn("Erro no geocoding:", error);
        return null;
    }
}

// Search Parameters
function buildSearchParameters(geminiData) {
    const estabelecimento = geminiData.estabelecimento || '';
    const categoria = (geminiData.categoria || '').toLowerCase();

    // Determina categoria Mapbox
    let searchCategory = 'poi';
    for (const [key, value] of Object.entries(categoryMap)) {
        if (categoria.includes(key)) {
            searchCategory = value;
            break;
        }
    }

    let searchType = 'category';
    let searchQuery = searchCategory;

    const estabelecimentoLower = estabelecimento.toLowerCase().trim();

    // Verifica se é genérico
    let isGenerico = false;

    if (termosGenericos.includes(estabelecimentoLower)) {
        isGenerico = true;
    }

    if (estabelecimentoLower.split(' ').length < 2 && 
        termosGenericos.some(t => estabelecimentoLower.includes(t))) {
        isGenerico = true;
    }

    if (estabelecimento.includes('Não Identificado') || 
        estabelecimento.includes('Desconhecido') ||
        estabelecimento.includes('Erro')) {
        isGenerico = true;
    }

    // Decisão final
    if (!isGenerico && estabelecimento.length >= 3) {
        searchType = 'text';
        searchQuery = estabelecimento;
    } else {
        searchType = 'category';
        searchQuery = searchCategory;
    }

    console.log('--- SEARCH PARAMETERS ---');
    console.log('Nome Original:', estabelecimento);
    console.log('Categoria Detectada:', categoria);
    console.log('Mapbox Category:', searchCategory);
    console.log('É Genérico?', isGenerico);
    console.log('FINAL SEARCH TYPE:', searchType);
    console.log('FINAL QUERY:', searchQuery);

    return {
        search_type: searchType,
        search_query: searchQuery,
        mapbox_category: searchCategory,
        estabelecimento: estabelecimento,
        categoria: categoria
    };
}

// Search by Text (Mapbox Forward API)
async function searchByText(query, coordinates) {
    const url = `https://api.mapbox.com/search/searchbox/v1/forward?` +
        `access_token=${MAPBOX_TOKEN}` +
        `&q=${encodeURIComponent(query)}` +
        `&language=pt` +
        `&limit=6` +
        `&proximity=${coordinates.longitude},${coordinates.latitude}` +
        `&types=poi`;

    try {
        const response = await fetch(url);
        if (!response.ok) return [];
        
        const data = await response.json();
        return data.features || [];
    } catch (error) {
        console.error("Erro Search by Text:", error);
        return [];
    }
}

// Search by Category ( Mapbox Category API)
async function searchByCategory(category, coordinates) {
    const url = `https://api.mapbox.com/search/searchbox/v1/category/${category}?` +
        `access_token=${MAPBOX_TOKEN}` +
        `&language=pt` +
        `&limit=6` +
        `&proximity=${coordinates.longitude},${coordinates.latitude}`;

    try {
        const response = await fetch(url);
        if (!response.ok) return [];
        
        const data = await response.json();
        return data.features || [];
    } catch (error) {
        console.error("Erro Search by Category:", error);
        return [];
    }
}

// Calcula distância Haversine
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

// Verifica similaridade de nomes
function isSimilarName(name1, name2) {
    if (!name1 || !name2) return false;
    
    const n1 = name1.toLowerCase().trim();
    const n2 = name2.toLowerCase().trim();
    
    if (n1.includes(n2) || n2.includes(n1)) return true;
    
    const words1 = n1.split(/\s+/);
    const words2 = n2.split(/\s+/);
    const commonWords = words1.filter(w => words2.includes(w) && w.length > 3);
    
    return commonWords.length > 0;
}

// Format Nearby Results
function formatNearbyResults(mapboxFeatures, geminiData, searchParams, coordinates, userLocation) {
    if (!mapboxFeatures || mapboxFeatures.length === 0) {
        return [{
            nome: `Nenhum local encontrado`,
            tipo: searchParams.search_type === 'text' 
                ? `Nenhuma unidade de "${searchParams.estabelecimento}" próxima` 
                : 'Nenhum estabelecimento similar encontrado',
            distancia: "—",
            endereco: coordinates.place_name || "Localização não identificada"
        }];
    }

    const estabelecimentoBuscado = searchParams.estabelecimento || searchParams.search_query || '';
    const isTextSearch = searchParams.search_type === 'text';

    let locais = mapboxFeatures
        .filter(feature => {
            // Se buscou por texto, filtra apenas similares
            if (isTextSearch) {
                const featureName = feature.properties?.name || feature.name || '';
                return isSimilarName(featureName, estabelecimentoBuscado);
            }
            return true;
        })
        .map(feature => {
            const coords = feature.geometry.coordinates;
            const distance = calculateDistance(
                userLocation.latitude,
                userLocation.longitude,
                coords[1],
                coords[0]
            );

            let tipo = "Estabelecimento";
            const props = feature.properties || {};
            
            if (props.poi_category && props.poi_category.length > 0) {
                const category = props.poi_category[0];
                const translations = {
                    'restaurant': 'Restaurante',
                    'cafe': 'Café',
                    'bar': 'Bar',
                    'fast_food': 'Fast Food',
                    'grocery': 'Supermercado'
                };
                tipo = translations[category] || category.replace(/_/g, ' ');
            }

            return {
                nome: props.name || feature.name || "Local",
                tipo: tipo,
                distancia: distance < 1 ? 
                    `${Math.round(distance * 1000)}m` : 
                    `${distance.toFixed(1)}km`,
                endereco: props.full_address || props.address || props.place_formatted || "",
                coordenadas: {
                    latitude: coords[1],
                    longitude: coords[0]
                }
            };
        })
        .slice(0, 6);

    if (locais.length === 0) {
        return [{
            nome: `Nenhum local encontrado`,
            tipo: searchParams.search_type === 'text' 
                ? `Nenhuma unidade de "${estabelecimentoBuscado}" próxima` 
                : 'Nenhum estabelecimento similar encontrado',
            distancia: "—",
            endereco: coordinates.place_name || "Localização não identificada"
        }];
    }

    return locais;
}

// Geolocalização do usuário
function getUserLocation() {
    return new Promise((resolve) => {
        if (!navigator.geolocation) {
            resolve({ latitude: -19.3066, longitude: -48.9234 }); // Prata-MG
            return;
        }
        navigator.geolocation.getCurrentPosition(
            (pos) => {
                resolve({ 
                    latitude: pos.coords.latitude, 
                    longitude: pos.coords.longitude 
                });
            },
            (err) => { 
                console.warn("GPS negado, usando Prata-MG"); 
                resolve({ latitude: -19.3066, longitude: -48.9234 });
            }
        );
    });
}

function showResults(data) {
    uploadSection.classList.add('hidden');
    resultsSection.classList.remove('hidden');

    elements.name.textContent = data.estabelecimento;
    elements.category.textContent = data.categoria;
    elements.style.textContent = data.estilo;
    elements.desc.textContent = data.descricao;

    elements.tags.innerHTML = '';
    (data.tags || []).forEach(tag => {
        const span = document.createElement('span');
        span.className = 'tag'; 
        span.textContent = tag;
        elements.tags.appendChild(span);
    });

    elements.features.innerHTML = '';
    const feats = [
        { icon: 'store', label: 'Categoria', val: data.categoria },
        { icon: 'smart_toy', label: 'IA', val: 'Gemini 2.5' }
    ];
    feats.forEach(f => {
        const d = document.createElement('div');
        d.className = 'feature-box';
        d.innerHTML = `<span class="material-symbols-outlined">${f.icon}</span><strong>${f.label}</strong><small>${f.val}</small>`;
        elements.features.appendChild(d);
    });

    renderNearby(data.locais_proximos, data.user_location);
}

function renderNearby(locais, userLoc) {
    elements.nearby.innerHTML = '';
    elements.nearbyCard.style.display = 'block'; 
    
    setTimeout(() => {
        initMap(userLoc, locais || []);
        if (map) map.resize(); 
    }, 100);

    if (!locais || locais.length === 0) {
        elements.nearby.innerHTML = '<div style="padding:15px; color:#666; text-align:center; grid-column:1/-1;">Nenhum local encontrado.</div>';
        return;
    }

    locais.forEach(local => {
        const div = document.createElement('div');
        div.className = 'location-card';
        
        let icon = 'place';
        const tipoLower = (local.tipo || '').toLowerCase();
        if(tipoLower.includes('restaurante')) icon = 'restaurant';
        else if(tipoLower.includes('café') || tipoLower.includes('cafe')) icon = 'local_cafe';
        else if(tipoLower.includes('mercado')) icon = 'shopping_cart';
        else if(tipoLower.includes('farmácia')) icon = 'local_pharmacy';
        
        div.innerHTML = `
            <div class="loc-icon"><span class="material-symbols-outlined">${icon}</span></div>
            <div class="loc-info">
                <strong>${local.nome}</strong>
                <span>${local.endereco || local.tipo}</span>
            </div>
            <div class="loc-meta">
                <div class="loc-dist">${local.distancia || ''}</div>
            </div>
        `;
        elements.nearby.appendChild(div);
    });
}

function initMap(userLoc, locais) {
    if (typeof mapboxgl === 'undefined') {
        console.error("Mapbox GL JS não carregado");
        return;
    }
    
    mapboxgl.accessToken = MAPBOX_TOKEN;

    if (map) map.remove();
    
    map = new mapboxgl.Map({
        container: 'map', 
        style: 'mapbox://styles/mapbox/streets-v12',
        center: [userLoc.longitude, userLoc.latitude], 
        zoom: 13
    });

    map.addControl(new mapboxgl.NavigationControl());

    // Marcador Usuário
    new mapboxgl.Marker({ color: '#007bff' })
        .setLngLat([userLoc.longitude, userLoc.latitude])
        .setPopup(new mapboxgl.Popup().setHTML('<strong>Sua Localização</strong>'))
        .addTo(map);

    // Marcadores Locais
    if (locais && locais.length > 0) {
        locais.forEach((local, index) => {
            if (local.coordenadas) {
                const marker = new mapboxgl.Marker({ color: '#f59e0b' })
                    .setLngLat([local.coordenadas.longitude, local.coordenadas.latitude])
                    .setPopup(new mapboxgl.Popup().setHTML(`
                        <strong>${local.nome}</strong><br>
                        ${local.tipo}<br>
                        <small>${local.distancia}</small>
                    `))
                    .addTo(map);
                
                if (index === 0) marker.togglePopup();
            }
        });
        
        // Ajusta zoom
        const bounds = new mapboxgl.LngLatBounds();
        bounds.extend([userLoc.longitude, userLoc.latitude]);
        locais.forEach(loc => {
            if (loc.coordenadas) {
                bounds.extend([loc.coordenadas.longitude, loc.coordenadas.latitude]);
            }
        });
        map.fitBounds(bounds, { padding: 50 });
    }
}

function addToHistory(data, url) {
    const li = document.createElement('li');
    li.className = 'history-item';
    li.innerHTML = `<img src="${url}"><div class="history-item-info"><strong>${data.estabelecimento}</strong><span>${new Date().toLocaleTimeString('pt-BR')}</span></div>`;
    li.onclick = () => showResults(data);
    
    if(elements.historyList.querySelector('.history-placeholder')) {
        elements.historyList.innerHTML = '';
    }
    elements.historyList.prepend(li);
}

window.resetApp = function() {
    uploadSection.classList.remove('hidden');
    resultsSection.classList.add('hidden');
    elements.img.src = "";
    fileInput.value = "";
}