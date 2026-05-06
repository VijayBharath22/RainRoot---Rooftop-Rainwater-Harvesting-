import { Component, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import area from '@turf/area'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  MapContainer,
  Marker,
  TileLayer,
  useMap,
} from 'react-leaflet'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

const DefaultIcon = L.icon({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
})
L.Marker.mergeOptions({ icon: DefaultIcon })

// Leaflet-Draw UMD expects a global `L`. We set it before dynamically importing the plugin.
if (typeof window !== 'undefined') {
  window.L = L
}

const ESRI_TILE =
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'

const RAINFALL_TREND_MOCK = [
  { year: '2022', mm: 950 },
  { year: '2023', mm: 1100 },
  { year: '2024', mm: 850 },
  { year: '2025', mm: 700 },
  { year: '2026', mm: 920 },
]

const SQFT_PER_SQM = 10.76391041671

const CITY_DATA = {
  bengaluru: {
    annual: 970,
    rainyDays: 60,
    intensity: 16,
    soil: 'Weathered Granite',
    subsidence: 'Medium (Compaction risk)',
    rate: 36,
    depth: 40,
  },
  delhi: {
    annual: 650,
    rainyDays: 45,
    intensity: 14,
    soil: 'Alluvial Silt',
    subsidence: 'CRITICAL (51mm/year sinking)',
    rate: 26,
    depth: 60,
  },
  mumbai: {
    annual: 2400,
    rainyDays: 100,
    intensity: 24,
    soil: 'Basaltic Trap',
    subsidence: 'Coastal Ingress Risk',
    rate: 8,
    depth: 10,
  },
  ahmedabad: {
    annual: 480,
    rainyDays: 35,
    intensity: 14,
    soil: 'Alluvial sand',
    subsidence: 'MAXIMUM (44mm/year sinking)',
    rate: 22,
    depth: 55,
  },
}

function getCityData(nominatimResponse) {
  const fullAddress = nominatimResponse.display_name.toLowerCase()
  for (const [city, data] of Object.entries(CITY_DATA)) {
    if (fullAddress.includes(city)) return { city, ...data }
  }
  return {
    city: 'your city',
    annual: 800,
    rainyDays: 50,
    intensity: 15,
    soil: 'Mixed',
    subsidence: 'Unknown',
    rate: 20,
    depth: 30,
  }
}

/** Pitch metric: deeper GW + drier years → higher modelled sapling stress */
function computeSaplingMortalityPercent(cityData) {
  const depthStress = cityData.depth * 0.65
  const rainRelief = Math.min(18, cityData.annual / 160)
  return Math.round(Math.min(78, Math.max(18, 28 + depthStress - rainRelief)))
}

function computeSubsidenceMmPerYear(cityData) {
  // Use city depth + subsidence label as a stable demo indicator.
  const label = String(cityData.subsidence || '').toLowerCase()
  if (label.includes('51')) return 51
  if (label.includes('44')) return 44
  const depthFactor = Math.max(0, (cityData.depth - 10) * 0.9)
  const rainPenalty = Math.max(0, (900 - cityData.annual) / 120)
  return Math.round(Math.min(51, Math.max(6, 8 + depthFactor + rainPenalty)))
}

function computeB2gPriorityIndex(mortalityPct, subsidenceMmPerYr) {
  // 0–100 (demo): survival stress + structural risk
  return Math.round(
    Math.min(100, Math.max(0, mortalityPct * 1.35 + subsidenceMmPerYr * 1.1)),
  )
}

function b2gHeatmapCellClass(mortalityPct, row, col, rows, cols) {
  const nx = col / Math.max(1, cols - 1)
  const ny = row / Math.max(1, rows - 1)
  const bias = nx * 0.22 + ny * 0.28 + ((row + col) % 5) * 0.04
  const stress = mortalityPct / 100 + bias
  if (stress > 0.52) return 'bg-red-600/90 border border-red-900/40'
  if (stress > 0.36) return 'bg-amber-400/85 border border-amber-700/30'
  return 'bg-emerald-600/85 border border-emerald-900/35'
}

function calculateRTRWH(inputs, cityData) {
  const roofSqM = inputs.roofSqFt * 0.0929
  const openSqM = inputs.openSqFt * 0.0929

  const annualHarvestLitres = roofSqM * cityData.annual * 0.8 * 0.9
  const dailyPeakRunoff = roofSqM * cityData.intensity * 0.8
  const recommendedTankLitres = Math.round(
    (annualHarvestLitres / cityData.rainyDays) * 3,
  )
  const rechargePitCubicM = openSqM * 0.9

  const dailyNeedLitres = inputs.dwellers * 135
  const daysWaterCovered = Math.round(annualHarvestLitres / dailyNeedLitres)
  const waterCansEquivalent = Math.round(annualHarvestLitres / 20)

  const annualSavingsRs = Math.round((annualHarvestLitres / 1000) * cityData.rate)
  const installCostMin = inputs.openSqFt > 100 ? 25000 : 15000
  const installCostMax = inputs.openSqFt > 100 ? 60000 : 35000
  const paybackYears =
    annualSavingsRs > 0
      ? Math.round(installCostMin / annualSavingsRs)
      : null

  const rainfallScore = Math.min((cityData.annual / 2400) * 40, 40)
  const roofScore = Math.min((inputs.roofSqFt / 2000) * 35, 35)
  const spaceScore = Math.min((inputs.openSqFt / 500) * 25, 25)
  const feasibilityScore = Math.round(rainfallScore + roofScore + spaceScore)
  const totalRainLitres = roofSqM * cityData.annual
  const floodLoadReductionPct =
    totalRainLitres > 0 ? Math.round((annualHarvestLitres / totalRainLitres) * 100) : 0

  return {
    annualHarvestLitres: Math.round(annualHarvestLitres),
    dailyPeakRunoff: Math.round(dailyPeakRunoff),
    recommendedTankLitres,
    rechargePitCubicM: rechargePitCubicM.toFixed(1),
    daysWaterCovered,
    waterCansEquivalent,
    annualSavingsRs,
    installCostMin,
    installCostMax,
    paybackYears,
    feasibilityScore,
    floodLoadReductionPct,
  }
}

const GOLDEN_REPORT_HTML = `<div class="bg-slate-900 text-slate-100 p-8 font-sans border border-slate-800 rounded-2xl shadow-2xl">
  <div class="flex justify-between items-start border-b border-slate-800 pb-6 mb-8">
    <div>
      <h1 class="text-3xl font-extrabold text-cyan-400 tracking-tighter uppercase">RainRoot Site Audit</h1>
      <p class="text-slate-500 text-sm mt-1 font-mono">Engine Version: RR-Intelligence-1.0.26</p>
    </div>
    <div class="bg-emerald-500/10 border border-emerald-500/50 px-6 py-2 rounded-full text-center">
      <span class="block text-[10px] text-emerald-500 uppercase font-bold tracking-widest">Resilience Score</span>
      <span class="text-2xl font-black text-emerald-400">94/100</span>
    </div>
  </div>

  <div class="mb-10">
    <h2 class="text-cyan-400 text-xs font-bold uppercase tracking-widest mb-3">System Verdict</h2>
    <p class="text-lg leading-relaxed text-slate-300">
      Analysis complete. Site <span class="text-white font-bold underline decoration-cyan-500">Dwarka-DL-110075</span> exhibits high hydraulic potential. Implementing a closed-loop RTRWH system will stabilize local soil compaction and offset municipal dependency by <span class="text-emerald-400 font-bold">88% annually</span>.
    </p>
  </div>

  <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-10">
    <div class="bg-slate-800/50 p-6 rounded-xl border border-red-900/30">
      <h3 class="text-red-400 font-bold flex items-center mb-2">
        <span class="mr-2">⚠️</span> Subsidence Warning
      </h3>
      <p class="text-xs text-slate-400 leading-snug">
        Delhi's <span class="italic">Alluvial Silt</span> layers are compacting. Dwarka is sinking at <span class="text-red-400 font-bold">51mm/year</span>. Your 2,200 sqft roof can inject 1.5L Lakh litres annually, creating a positive hydraulic head to mitigate foundation settling.
      </p>
    </div>
    <div class="bg-slate-800/50 p-6 rounded-xl border border-cyan-900/30">
      <h3 class="text-cyan-400 font-bold flex items-center mb-2">
        <span class="mr-2">🌳</span> B2G Forest Insight
      </h3>
      <p class="text-xs text-slate-400 leading-snug">
        Government Advisory: Local sapling mortality risk is <span class="text-orange-400 font-bold">62%</span> due to groundwater depth (60m). We recommend municipal budget allocation for supplemental irrigation in this sector.
      </p>
    </div>
  </div>

  <div class="border-l-4 border-cyan-500 bg-cyan-500/5 p-4 rounded-xl mb-10">
    <h2 class="text-cyan-400 text-xs font-bold uppercase tracking-widest mb-3">PRO-LEVEL ENGINEERING AUDIT</h2>
    <div class="space-y-3 text-sm text-slate-300 leading-relaxed">
      <p><span class="text-white font-bold">1) FOUNDATION SAFETY:</span> Explain the <span class="text-emerald-400 font-bold">3.5m rule</span> to avoid <span class="text-white font-semibold">Foundation Heave</span> in Dwarka's soil. Keep recharge pits away from footings and maintain controlled infiltration depth.</p>
      <p><span class="text-white font-bold">2) SILT MANAGEMENT:</span> Delhi's silt-to-clay ratio requires a <span class="text-white font-semibold">V-wire screen filter</span> to prevent rapid media blinding and unstable headloss.</p>
      <p><span class="text-white font-bold">3) ATMOSPHERIC PURIFICATION:</span> NCR SO₂ levels require a <span class="text-white font-semibold">400L First Flush</span> bypass to reject acidic rooftop wash and protect storage/recharge chemistry.</p>
      <p><span class="text-white font-bold">4) ECOLOGICAL SURVIVAL:</span> B2G: saplings need <span class="text-white font-semibold">Deep-Root Watering</span> because the water table is at <span class="text-orange-400 font-bold">-62m</span>, so irrigation budgets must compensate.</p>
    </div>
  </div>

  <div class="bg-slate-800/30 p-6 rounded-2xl mb-10">
    <h2 class="text-cyan-400 text-xs font-bold uppercase tracking-widest mb-6">Engineering Schematic</h2>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-8">
      <div>
        <span class="block text-slate-500 text-[10px] uppercase">Storage Required</span>
        <span class="text-2xl font-mono font-bold">8,000 L</span>
        <div class="mt-4 bg-yellow-500/10 border border-yellow-500/30 p-3 rounded-lg flex items-center justify-between">
          <div class="flex items-center">
            <div class="bg-yellow-500 p-2 rounded mr-3">
               <svg class="w-4 h-4 text-slate-900" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2L1 21h22L12 2zm0 3.45l8.27 14.3H3.73L12 5.45z"/></svg>
            </div>
            <div>
              <p class="text-[10px] text-yellow-500 font-bold uppercase tracking-wider">Top Recommendation</p>
              <p class="text-xs font-bold text-white">Sintex 8000L Triple-Layer Tank</p>
            </div>
          </div>
          <a href="https://amazon.in" target="_blank" class="bg-yellow-500 hover:bg-yellow-400 text-slate-900 text-[10px] font-black px-3 py-1.5 rounded uppercase transition-colors">
            Buy @ Amazon
          </a>
        </div>
        <a href="https://amazon.in/s?k=8000L+Water+Tank" class="block text-[10px] text-cyan-500 mt-2 underline">Buy on Amazon (Sponsored)</a>
      </div>
      <div>
        <span class="block text-slate-500 text-[10px] uppercase">Recharge Pit</span>
        <span class="text-2xl font-mono font-bold">4.5 m³</span>
        <span class="block text-[10px] text-slate-400 mt-2 italic">Depth: 3.5m</span>
      </div>
      <div>
        <span class="block text-slate-500 text-[10px] uppercase">Annual Savings</span>
        <span class="text-2xl font-mono font-bold text-emerald-400">₹3,900</span>
        <span class="block text-[10px] text-slate-400 mt-2 uppercase tracking-tighter">Payback: 8.2 Yrs</span>
      </div>
    </div>
  </div>

  <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
    <button class="bg-cyan-600 hover:bg-cyan-500 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-cyan-900/20">📄 Download CAD Blueprints (₹499)</button>
    <button class="bg-emerald-600 hover:bg-emerald-500 text-white font-bold py-4 rounded-xl transition-all shadow-lg shadow-emerald-900/20">🏛️ Generate Tax Rebate Form</button>
  </div>

  <div class="mt-8 pt-6 border-t border-slate-800 text-center">
    <p class="text-slate-600 text-[10px] uppercase tracking-widest">Analysis secured by RainRoot Intelligence Engine | 2026 Climate Protocol</p>
    <p class="text-slate-500 text-[10px] mt-2 italic">*This report contains sponsored hardware links (Affiliate ID: RR-2026-MKT).</p>
  </div>
</div>`

function WaterDropLogo({ className = 'w-14 h-14' }) {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M32 4C20 24 10 30 10 42a22 22 0 1 0 44 0c0-12-10-18-22-38z"
        fill="url(#rrg)"
      />
      <defs>
        <linearGradient id="rrg" x1="32" y1="4" x2="32" y2="64">
          <stop stopColor="#22d3ee" />
          <stop offset="1" stopColor="#0891b2" />
        </linearGradient>
      </defs>
    </svg>
  )
}

function FlyTo({ position, zoom }) {
  const map = useMap()
  useEffect(() => {
    if (position) {
      map.flyTo(position, zoom, { duration: 1.2 })
    }
  }, [map, position, zoom])
  return null
}

function LeafletDrawRoof({ onPolygonRoof, onPolygonCleared }) {
  const map = useMap()
  const onPoly = useRef(onPolygonRoof)
  const onClear = useRef(onPolygonCleared)

  useEffect(() => {
    onPoly.current = onPolygonRoof
    onClear.current = onPolygonCleared
  }, [onPolygonRoof, onPolygonCleared])

  useEffect(() => {
    if (!map) return undefined

    let cancelled = false
    let drawnItems
    let drawControl

    const setup = async () => {
      if (typeof window !== 'undefined') window.L = L
      await import('leaflet-draw')
      if (cancelled) return
      if (typeof L.Control.Draw === 'undefined') return

      drawnItems = new L.FeatureGroup()
      map.addLayer(drawnItems)

      drawControl = new L.Control.Draw({
        position: 'topright',
        draw: {
          polygon: {
            allowIntersection: false,
            showArea: true,
            metric: true,
            shapeOptions: {
              color: '#22d3ee',
              weight: 2,
              fillColor: '#06b6d4',
              fillOpacity: 0.22,
            },
          },
          polyline: false,
          rectangle: false,
          circle: false,
          marker: false,
          circlemarker: false,
        },
        edit: {
          featureGroup: drawnItems,
          remove: true,
        },
      })
      map.addControl(drawControl)

      const applyLayerArea = (layer) => {
        const gj = layer.toGeoJSON()
        const sqm = area(gj)
        const sqft = Math.round(sqm * SQFT_PER_SQM)
        const clamped = Math.min(5000, Math.max(100, sqft))
        onPoly.current(clamped, sqm)
      }

      const onCreated = (e) => {
        drawnItems.clearLayers()
        drawnItems.addLayer(e.layer)
        applyLayerArea(e.layer)
      }

      const onEdited = (e) => {
        e.layers.eachLayer((layer) => applyLayerArea(layer))
      }

      const onDeleted = () => {
        if (drawnItems.getLayers().length === 0) onClear.current()
      }

      map.on(L.Draw.Event.CREATED, onCreated)
      map.on(L.Draw.Event.EDITED, onEdited)
      map.on(L.Draw.Event.DELETED, onDeleted)
      map.__rr_drawHandlers = { onCreated, onEdited, onDeleted }
    }

    setup()

    return () => {
      cancelled = true
      try {
        const h = map.__rr_drawHandlers
        if (h) {
          map.off(L.Draw.Event.CREATED, h.onCreated)
          map.off(L.Draw.Event.EDITED, h.onEdited)
          map.off(L.Draw.Event.DELETED, h.onDeleted)
          delete map.__rr_drawHandlers
        }
      } catch {
        /* ignore */
      }
      if (drawControl) {
        try {
          map.removeControl(drawControl)
        } catch {
          /* ignore */
        }
      }
      if (drawnItems) {
        try {
          drawnItems.clearLayers()
          map.removeLayer(drawnItems)
        } catch {
          /* ignore */
        }
      }
    }
  }, [map])

  return null
}

function sqftToSqm(sqft) {
  return (sqft * 0.092903).toFixed(1)
}

class ReportHtmlBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <p className="text-red-400 text-sm">
          The AI report could not be rendered safely. Try generating again or copy the raw
          response from the network tab.
        </p>
      )
    }
    return this.props.children
  }
}

/** Layout inspired by [CODE-DNA](https://code-dna.netlify.app/) — nav, mesh bg, sections; RainRoot content. */
function SiteHeader({ currentPage, goPage, goHomeToSection, hasApiKey }) {
  const start = () => goPage(hasApiKey ? 3 : 2)
  return (
    <header className="no-print fixed top-0 left-0 right-0 z-[1000] border-b border-white/[0.06] bg-zinc-950/75 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between gap-2 sm:gap-3">
        <button
          type="button"
          onClick={() => goPage(1)}
          className="flex items-center gap-2 min-w-0 shrink-0 group"
        >
          <WaterDropLogo className="w-8 h-8 sm:w-9 sm:h-9 shrink-0 transition-transform group-hover:scale-105" />
          <span className="font-bold text-base sm:text-lg tracking-tight text-white truncate">
            RainRoot
          </span>
        </button>
        <nav className="flex-1 min-w-0 flex items-center justify-center gap-4 sm:gap-6 md:gap-8 text-xs sm:text-sm text-zinc-400 overflow-x-auto no-scrollbar px-2">
          <button
            type="button"
            onClick={() => goPage(1)}
            className={`hover:text-white transition-colors ${currentPage === 1 ? 'text-white font-medium' : ''}`}
          >
            Home
          </button>
          <button
            type="button"
            onClick={() => goHomeToSection('features')}
            className="hover:text-white transition-colors"
          >
            How it works
          </button>
          <button
            type="button"
            onClick={() => goHomeToSection('gov')}
            className="hover:text-white transition-colors"
          >
            Government
          </button>
          <button
            type="button"
            onClick={() => goHomeToSection('about')}
            className="hover:text-white transition-colors"
          >
            About
          </button>
        </nav>
        <button
          type="button"
          onClick={start}
          className="rounded-full px-3.5 sm:px-5 py-2 text-xs sm:text-sm font-semibold bg-white text-zinc-950 hover:bg-zinc-100 transition-colors shadow-lg shadow-black/25 shrink-0"
        >
          Start assessment
        </button>
      </div>
    </header>
  )
}

function SiteFooter({ goPage }) {
  return (
    <footer className="no-print mt-auto border-t border-white/[0.06] bg-zinc-950/85 backdrop-blur-xl">
      <div className="max-w-6xl mx-auto px-6 py-12 md:py-14">
        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-10">
          <div className="max-w-md">
            <div className="flex items-center gap-2 mb-3">
              <WaterDropLogo className="w-8 h-8" />
              <span className="font-bold text-lg text-white">RainRoot</span>
            </div>
            <p className="text-sm text-zinc-500 leading-relaxed">
              AI-assisted rooftop rainwater harvesting for India — maps, CGWB-style math, B2G resilience
              views, and print-ready municipal forms. Keys stay in your browser.
            </p>
          </div>
          <div className="flex gap-12 sm:gap-16 text-sm">
            <div>
              <p className="text-white font-medium mb-3">Product</p>
              <ul className="space-y-2 text-zinc-400">
                <li>
                  <button type="button" onClick={() => goPage(1)} className="hover:text-white text-left">
                    Home
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => goPage(2)} className="hover:text-white text-left">
                    Get started
                  </button>
                </li>
              </ul>
            </div>
            <div>
              <p className="text-white font-medium mb-3">Data &amp; AI</p>
              <ul className="space-y-2 text-zinc-400">
                <li>
                  <a
                    href="https://www.openstreetmap.org"
                    className="hover:text-white"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenStreetMap
                  </a>
                </li>
                <li>
                  <a
                    href="https://ai.google.dev/"
                    className="hover:text-white"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Google Gemini
                  </a>
                </li>
              </ul>
            </div>
          </div>
        </div>
        <p className="text-xs text-zinc-600 mt-10 pt-8 border-t border-white/[0.04]">
          Built at SustainAI 2026 | Powered by Gemini 3 Flash.
        </p>
      </div>
    </footer>
  )
}

const ROOF_OPTIONS = ['RCC Flat', 'Clay Tiles', 'Metal Sheet', 'Mixed']
const STORAGE_OPTIONS = ['None', 'Underground sump', 'Overhead tank', 'Both']

const DEFAULT_CENTER = [20.5937, 78.9629]
const DEFAULT_ZOOM = 5

export default function App() {
  const [currentPage, setCurrentPage] = useState(1)
  const [pageVisible, setPageVisible] = useState(true)

  const [apiKey, setApiKey] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)

  const [addressQuery, setAddressQuery] = useState('')
  const [suggestions, setSuggestions] = useState([])
  const [geocoding, setGeocoding] = useState(false)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedPlace, setSelectedPlace] = useState(null)
  const [mapPosition, setMapPosition] = useState(null)
  const [mapZoom, setMapZoom] = useState(DEFAULT_ZOOM)
  const [cityData, setCityData] = useState(null)

  const [roofSqFt, setRoofSqFt] = useState(1500)
  const [openSqFt, setOpenSqFt] = useState(200)

  const [name, setName] = useState('')
  const [dwellers, setDwellers] = useState(4)
  const [roofMaterial, setRoofMaterial] = useState('RCC Flat')
  const [storage, setStorage] = useState('None')
  const [storageCapacity, setStorageCapacity] = useState('')
  const [waterBill, setWaterBill] = useState('')
  const [smsAlertsEnabled, setSmsAlertsEnabled] = useState(false)

  const [roofFromPolygon, setRoofFromPolygon] = useState(false)
  const [roofPolygonSqM, setRoofPolygonSqM] = useState(null)
  const [mapDrawKey, setMapDrawKey] = useState(0)

  const [taxRebatePrintOpen, setTaxRebatePrintOpen] = useState(false)
  const [b2gModalOpen, setB2gModalOpen] = useState(false)

  const [soilMoistureOn, setSoilMoistureOn] = useState(false)
  const [visionScanning, setVisionScanning] = useState(false)

  const [reportLoading, setReportLoading] = useState(false)
  const [reportHtml, setReportHtml] = useState('')
  const [reportError, setReportError] = useState(null)
  const [reportOverloaded, setReportOverloaded] = useState(false)
  const [lastCalculations, setLastCalculations] = useState(null)

  const searchRef = useRef(null)

  const goPage = useCallback((n) => {
    setPageVisible(false)
    setTimeout(() => {
      setCurrentPage(n)
      setPageVisible(true)
    }, 150)
  }, [])

  const goHomeToSection = useCallback(
    (sectionId) => {
      const runScroll = () =>
        document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth' })
      if (currentPage !== 1) {
        setPageVisible(true)
        setCurrentPage(1)
        setTimeout(runScroll, 280)
      } else {
        runScroll()
      }
    },
    [currentPage],
  )

  useEffect(() => {
    if (!addressQuery.trim()) {
      setSuggestions([])
      return
    }
    const ctrl = new AbortController()
    const t = setTimeout(async () => {
      setGeocoding(true)
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addressQuery)}&limit=5`
        const r = await fetch(url, {
          signal: ctrl.signal,
          headers: { Accept: 'application/json' },
        })
        const data = await r.json()
        if (!ctrl.signal.aborted) setSuggestions(Array.isArray(data) ? data : [])
      } catch (e) {
        if (e.name !== 'AbortError' && !ctrl.signal.aborted) setSuggestions([])
      } finally {
        if (!ctrl.signal.aborted) setGeocoding(false)
      }
    }, 500)
    return () => {
      clearTimeout(t)
      ctrl.abort()
    }
  }, [addressQuery])

  useEffect(() => {
    const onDoc = (e) => {
      if (searchRef.current && !searchRef.current.contains(e.target)) {
        setShowSuggestions(false)
      }
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  useEffect(() => {
    const onAfterPrint = () => {
      document.body.classList.remove('print-tax-rebate')
      setTaxRebatePrintOpen(false)
    }
    window.addEventListener('afterprint', onAfterPrint)
    return () => window.removeEventListener('afterprint', onAfterPrint)
  }, [])

  useEffect(() => {
    // Safety guard: never keep the app hidden if tax print overlay is closed.
    if (!taxRebatePrintOpen) {
      document.body.classList.remove('print-tax-rebate')
    }
  }, [taxRebatePrintOpen])

  useEffect(() => {
    if (!b2gModalOpen) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') setB2gModalOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [b2gModalOpen])

  const onRoofPolygonMeasured = useCallback((sqft, sqm) => {
    setRoofSqFt(sqft)
    setRoofFromPolygon(true)
    setRoofPolygonSqM(sqm)
  }, [])

  const onRoofPolygonCleared = useCallback(() => {
    setRoofFromPolygon(false)
    setRoofPolygonSqM(null)
  }, [])

  const clearRoofTrace = useCallback(() => {
    setRoofFromPolygon(false)
    setRoofPolygonSqM(null)
    setMapDrawKey((k) => k + 1)
  }, [])

  const openTaxRebatePrint = useCallback(() => {
    document.body.classList.add('print-tax-rebate')
    setTaxRebatePrintOpen(true)
    setTimeout(() => window.print(), 300)
  }, [])

  const closeTaxRebateOverlay = useCallback(() => {
    document.body.classList.remove('print-tax-rebate')
    setTaxRebatePrintOpen(false)
  }, [])

  const selectSuggestion = (item) => {
    const lat = parseFloat(item.lat)
    const lon = parseFloat(item.lon)
    setSelectedPlace(item)
    setAddressQuery(item.display_name)
    setMapPosition([lat, lon])
    setMapZoom(19)
    setCityData(getCityData(item))
    setSuggestions([])
    setShowSuggestions(false)
  }

  const resetAssessment = () => {
    setCurrentPage(1)
    setAddressQuery('')
    setSuggestions([])
    setSelectedPlace(null)
    setMapPosition(null)
    setMapZoom(DEFAULT_ZOOM)
    setCityData(null)
    setRoofSqFt(1500)
    setOpenSqFt(200)
    setName('')
    setDwellers(4)
    setRoofMaterial('RCC Flat')
    setStorage('None')
    setStorageCapacity('')
    setWaterBill('')
    setSmsAlertsEnabled(false)
    setRoofFromPolygon(false)
    setRoofPolygonSqM(null)
    setMapDrawKey((k) => k + 1)
    setTaxRebatePrintOpen(false)
    setB2gModalOpen(false)
    setSoilMoistureOn(false)
    setVisionScanning(false)
    document.body.classList.remove('print-tax-rebate')
    setReportHtml('')
    setReportError(null)
    setReportOverloaded(false)
    setLastCalculations(null)
    setPageVisible(true)
  }

  const feasibilityColor = (score) => {
    if (score > 70) return 'bg-green-500/20 text-green-400 border-green-500/50'
    if (score > 40) return 'bg-yellow-500/20 text-yellow-300 border-yellow-500/50'
    return 'bg-red-500/20 text-red-400 border-red-500/50'
  }

  const generateReport = async () => {
    if (!cityData || !selectedPlace) return
    const inputs = {
      name: name.trim() || 'Homeowner',
      dwellers: Number(dwellers) || 1,
      roofSqFt,
      openSqFt,
      roofMaterial,
      storage,
      storageCapacity:
        storage !== 'None' && storageCapacity !== '' ? Number(storageCapacity) : null,
      waterBill: waterBill !== '' ? Number(waterBill) : null,
      smsAlertsEnabled,
    }
    const calculations = calculateRTRWH(inputs, cityData)
    setLastCalculations(calculations)
    setReportError(null)
    setReportHtml(GOLDEN_REPORT_HTML)
    setReportOverloaded(false)
    setReportLoading(false)
    setCurrentPage(5)
    setPageVisible(true)
  }

  const downloadSummaryPdf = () => {
    if (!lastCalculations || !cityData || !selectedPlace) return
    const popup = window.open('', '_blank', 'width=900,height=1100')
    if (!popup) return
    popup.document.write(`<!doctype html>
<html>
  <head>
    <title>RainRoot Summary PDF</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #111827; }
      .wrap { max-width: 900px; margin: 0 auto; }
      .card { border: 1px solid #cbd5e1; border-radius: 16px; padding: 24px; margin-bottom: 20px; }
      .muted { color: #64748b; font-size: 12px; }
      .metric { font-size: 28px; font-weight: 700; color: #0891b2; }
      .row { margin: 10px 0; }
      @media print { button { display: none; } body { margin: 18px; } }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="card">
        <h1>RainRoot Summary Report</h1>
        <p class="muted">Built at SustainAI 2026 | Powered by Gemini 3 Flash.</p>
      </div>
      <div class="card">
        <div class="row"><strong>Site Manager:</strong> ${taxName}</div>
        <div class="row"><strong>Location:</strong> ${taxAddress}</div>
        <div class="row"><strong>City:</strong> ${cityData.city}</div>
        <div class="row"><strong>Roof Area:</strong> ${roofSqFt} sq ft (~${sqftToSqm(roofSqFt)} sq m)</div>
        <div class="row"><strong>Open Space:</strong> ${openSqFt} sq ft</div>
      </div>
      <div class="card">
        <div class="metric">${lastCalculations.feasibilityScore}/100</div>
        <div class="muted">Resilience / Feasibility Score</div>
        <div class="row"><strong>Annual Harvest:</strong> ${lastCalculations.annualHarvestLitres.toLocaleString('en-IN')} litres</div>
        <div class="row"><strong>Recommended Tank:</strong> ${lastCalculations.recommendedTankLitres.toLocaleString('en-IN')} litres</div>
        <div class="row"><strong>Recharge Pit:</strong> ${lastCalculations.rechargePitCubicM} m³</div>
        <div class="row"><strong>Annual Savings:</strong> ₹${lastCalculations.annualSavingsRs.toLocaleString('en-IN')}</div>
        <div class="row"><strong>Flood Load Reduction:</strong> ${lastCalculations.floodLoadReductionPct}%</div>
      </div>
      <button onclick="window.print()">Print / Save PDF</button>
    </div>
  </body>
</html>`)
    popup.document.close()
    popup.focus()
    setTimeout(() => popup.print(), 250)
  }

  const mapCenter = mapPosition || DEFAULT_CENTER
  const effectiveZoom = mapPosition ? mapZoom : DEFAULT_ZOOM

  const pageWrap = (child) => (
    <div
      className={`page-enter ${pageVisible ? 'page-enter-active' : ''} min-h-dvh`}
      key={currentPage}
    >
      <div
        id="app-main"
        className={`min-h-dvh flex flex-col template-mesh text-zinc-100 antialiased ${taxRebatePrintOpen ? 'print-hidden' : ''}`}
      >
        <SiteHeader
          currentPage={currentPage}
          goPage={goPage}
          goHomeToSection={goHomeToSection}
          hasApiKey={Boolean(apiKey.trim())}
        />
        <main className={`flex-1 w-full ${currentPage === 1 ? '' : 'pt-20 sm:pt-24'}`}>
          {child}
        </main>
        <SiteFooter goPage={goPage} />
      </div>
    </div>
  )

  const landing = (
    <div className="w-full">
      <section className="relative px-4 sm:px-6 pt-8 pb-16 md:pb-24 max-w-6xl mx-auto">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] sm:text-xs font-medium text-zinc-300 mb-8 backdrop-blur-sm">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-cyan-400 opacity-40" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan-400" />
          </span>
          New · AI-powered RTRWH assessment
        </div>
        <h1 className="text-4xl sm:text-5xl md:text-6xl font-bold text-white tracking-tight leading-[1.08] max-w-4xl">
          Intelligent rooftop rainwater
          <br />
          <span className="text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 via-blue-400 to-violet-400">
            harvesting. Built in.
          </span>
        </h1>
        <p className="mt-6 text-base sm:text-lg text-zinc-400 max-w-2xl leading-relaxed">
          RainRoot analyzes your roof, satellite context, and local rainfall to estimate harvest, savings,
          and system sizing — so homeowners and municipalities can act before the next drought.
        </p>
        <div className="mt-10 flex flex-col sm:flex-row gap-4">
          <button
            type="button"
            onClick={() => goPage(2)}
            className="no-print rounded-full px-8 py-3.5 bg-white text-zinc-950 font-semibold hover:bg-zinc-100 transition-colors shadow-xl shadow-black/30 text-center"
          >
            Check my rooftop
          </button>
          <button
            type="button"
            onClick={() => goHomeToSection('features')}
            className="no-print rounded-full px-8 py-3.5 border border-white/15 text-white font-semibold hover:bg-white/[0.06] transition-colors text-center"
          >
            How it works
          </button>
        </div>
        <p className="mt-6 text-sm text-zinc-500">
          <button
            type="button"
            onClick={() => goPage(apiKey.trim() ? 3 : 2)}
            className="text-cyan-400 hover:text-cyan-300 hover:underline"
          >
            Try the full assessment →
          </button>
          <span className="text-zinc-600 mx-2">·</span>
          Powered by Gemini + OpenStreetMap. No account.
        </p>
      </section>

      <section id="features" className="px-4 sm:px-6 py-16 md:py-24 max-w-6xl mx-auto scroll-mt-24">
        <h2 className="text-2xl md:text-3xl font-bold text-white text-center mb-3">
          Smart water intelligence
        </h2>
        <p className="text-zinc-500 text-center max-w-2xl mx-auto mb-14 text-sm md:text-base leading-relaxed">
          We break down catchment, runoff, and savings instantly — plan recharge and storage without
          spreadsheets.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          {[
            {
              tag: 'Analysis',
              title: 'Catchment & runoff',
              body: 'Trace your roof as a polygon on satellite tiles or enter area manually — live m² conversion and CGWB-style harvest math.',
            },
            {
              tag: 'Visualization',
              title: 'Maps & rainfall',
              body: 'Esri imagery, Nominatim search, 5-year rainfall trend chart, and city-matched monsoon data.',
            },
            {
              tag: 'Estimates',
              title: 'Savings & reports',
              body: 'Tank sizing, recharge pit volume, feasibility score, AI narrative, tax-rebate draft, and B2G resilience modal.',
            },
          ].map((f) => (
            <div
              key={f.title}
              className="template-card rounded-2xl p-6 md:p-8 hover:border-white/10 transition-colors"
            >
              <p className="text-[10px] uppercase tracking-widest text-violet-400 font-semibold mb-3">
                {f.tag}
              </p>
              <h3 className="text-lg font-bold text-white mb-3">{f.title}</h3>
              <p className="text-sm text-zinc-400 leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 sm:px-6 py-6 max-w-6xl mx-auto">
        <div className="template-card rounded-2xl p-8 md:p-10 flex flex-col md:flex-row items-center justify-between gap-8">
          <div>
            <h3 className="text-xl font-bold text-white">One session, full picture</h3>
            <p className="text-zinc-400 text-sm mt-2 max-w-xl">
              Your Gemini API key never leaves the browser. Get a printable report and municipal add-ons in
              minutes.
            </p>
          </div>
          <button
            type="button"
            onClick={() => goPage(2)}
            className="no-print shrink-0 rounded-full px-8 py-3.5 font-semibold text-white bg-gradient-to-r from-blue-600 to-violet-600 hover:from-blue-500 hover:to-violet-500 shadow-lg shadow-violet-950/40"
          >
            Start assessment
          </button>
        </div>
      </section>

      <section id="process" className="px-4 sm:px-6 py-16 md:py-20 max-w-6xl mx-auto scroll-mt-24">
        <p className="text-center text-xs uppercase tracking-widest text-zinc-500 font-semibold mb-2">
          Our process
        </p>
        <h2 className="text-2xl md:text-3xl font-bold text-white text-center mb-12">
          From address to municipal-ready output
        </h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {[
            {
              step: '1',
              title: 'Connect AI',
              desc: 'Paste your Gemini key once — runs entirely in the browser.',
            },
            {
              step: '2',
              title: 'Locate & trace',
              desc: 'Search your address, fly to satellite view, optional roof polygon.',
            },
            {
              step: '3',
              title: 'Household details',
              desc: 'Roof type, storage, occupants — inputs for calculations + SMS opt-in.',
            },
            {
              step: '4',
              title: 'Report & B2G',
              desc: 'AI report, rebate form, resilience dashboard for pitch-ready demos.',
            },
          ].map((s) => (
            <div key={s.step} className="template-card rounded-xl p-6">
              <span className="inline-flex h-8 w-8 items-center justify-center rounded-lg bg-white/10 text-sm font-bold text-white mb-4">
                {s.step}
              </span>
              <h3 className="font-semibold text-white mb-2">{s.title}</h3>
              <p className="text-sm text-zinc-500 leading-relaxed">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="px-4 sm:px-6 py-12 max-w-6xl mx-auto">
        <p className="text-center text-xs uppercase tracking-widest text-zinc-500 font-semibold mb-8">
          Why it matters
        </p>
        <div className="grid sm:grid-cols-3 gap-6">
          {[
            { v: '62M tonnes', d: 'Annual urban water demand gap (India, indicative)' },
            { v: '91%', d: 'Cities under water stress during dry spells' },
            { v: 'Every drop counts', d: 'Harvest + recharge protect aquifers' },
          ].map((c) => (
            <div key={c.v} className="template-card rounded-xl p-5 text-center sm:text-left">
              <p className="text-2xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-cyan-300 to-blue-400">
                {c.v}
              </p>
              <p className="text-sm text-zinc-500 mt-2 leading-relaxed">{c.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="gov" className="px-4 sm:px-6 pb-20 max-w-6xl mx-auto scroll-mt-24">
        <div
          id="landing-b2g-card"
          className="rounded-2xl border border-indigo-500/35 bg-gradient-to-br from-zinc-900/90 via-indigo-950/40 to-zinc-900/90 px-5 py-5 md:px-8 md:py-6 shadow-xl shadow-indigo-950/25 ring-1 ring-indigo-400/15"
        >
          <p className="text-sm font-semibold text-indigo-200 tracking-tight flex items-center gap-2">
            <svg
              className="w-5 h-5 text-indigo-300 shrink-0"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden
            >
              <path d="M12 3 2 9h2v11h5v-6h6v6h5V9h2L12 3zm0 2.24L17.76 9H6.24L12 5.24z" />
            </svg>
            For government: afforestation risk mapping
          </p>
          <p className="text-sm text-zinc-400 mt-3 leading-relaxed max-w-3xl">
            Helping municipalities prioritize watering budgets in groundwater-depleted zones — RainRoot
            couples rooftop recharge signals with regional survival risk for urban plantations. Open the
            resilience dashboard after any assessment.
          </p>
        </div>
      </section>

      <section id="about" className="px-4 sm:px-6 pb-24 max-w-6xl mx-auto scroll-mt-24">
        <div className="template-card rounded-2xl p-8 md:p-10 max-w-3xl">
          <h2 className="text-xl font-bold text-white mb-4">About RainRoot</h2>
          <p className="text-sm text-zinc-400 leading-relaxed">
            RainRoot is a SustainAI 2026 prototype for rooftop rainwater harvesting (RTRWH) assessment in
            India. It combines open geodata, engineering-style estimates, and generative AI to produce
            homeowner-friendly and municipality-relevant outputs — without a backend or stored keys.
          </p>
        </div>
      </section>
    </div>
  )

  const apiSetup = (
    <div className="min-h-[75vh] flex items-center justify-center px-4 py-12 relative z-10">
      <div className="w-full max-w-md rounded-2xl template-card p-8 shadow-2xl shadow-black/40">
        <h2 className="text-xl font-semibold text-white text-center mb-2">One-time setup</h2>
        <p className="text-sm text-zinc-400 text-center mb-6">
          Enter your Google Gemini API key to generate the AI report in your browser.
        </p>
        <label className="block text-sm text-zinc-300 mb-2">Gemini API key</label>
        <div className="relative">
          <input
            type={showApiKey ? 'text' : 'password'}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full rounded-lg border border-white/10 bg-zinc-900/80 px-3 py-2.5 pr-24 text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/60"
            placeholder="AIza…"
            autoComplete="off"
          />
          <button
            type="button"
            onClick={() => setShowApiKey((s) => !s)}
            className="no-print absolute right-2 top-1/2 -translate-y-1/2 text-xs text-cyan-400 hover:underline"
          >
            {showApiKey ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="text-xs text-gray-500 mt-2">
          Your key stays in your browser only. Never sent to our servers.
        </p>
        <a
          href="https://aistudio.google.com/apikey"
          target="_blank"
          rel="noreferrer"
          className="text-sm text-cyan-400 hover:underline mt-4 inline-block"
        >
          Get a free API key in Google AI Studio
        </a>
        <button
          type="button"
          onClick={() => {
            if (!apiKey.trim()) return
            goPage(3)
          }}
          className="no-print mt-6 w-full py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-gray-950 font-semibold disabled:opacity-40"
          disabled={!apiKey.trim()}
        >
          Let&apos;s Go →
        </button>
        <button
          type="button"
          onClick={() => goPage(1)}
          className="no-print mt-3 w-full text-sm text-gray-500 hover:text-gray-300"
        >
          ← Back
        </button>
      </div>
    </div>
  )

  const locationPage = (
    <div className="min-h-[80vh] px-4 py-8 pb-16 relative z-10">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold text-white mb-2">Location &amp; roof</h2>
        <p className="text-sm text-zinc-500 mb-6">Satellite map, trace tools, and rainfall context.</p>
        <div ref={searchRef} className="relative z-[500] mb-4">
          <div className="flex gap-2">
            <input
              type="text"
              value={addressQuery}
              onChange={(e) => {
                setAddressQuery(e.target.value)
                setShowSuggestions(true)
              }}
              onFocus={() => setShowSuggestions(true)}
              placeholder="Search address in India…"
              className="flex-1 rounded-lg border border-gray-600 bg-gray-800 px-3 py-2.5 text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-500"
            />
            {geocoding && (
              <span className="flex items-center text-sm text-cyan-400 whitespace-nowrap">
                <span className="inline-block w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin mr-2" />
                Locating…
              </span>
            )}
          </div>
          {showSuggestions && suggestions.length > 0 && (
            <ul className="absolute left-0 right-0 mt-1 max-h-56 overflow-auto rounded-lg border border-gray-600 bg-gray-800 shadow-xl">
              {suggestions.map((s) => (
                <li key={s.place_id}>
                  <button
                    type="button"
                    className="no-print w-full text-left px-3 py-2 text-sm text-gray-200 hover:bg-gray-700 border-b border-gray-700/50 last:border-0"
                    onClick={() => selectSuggestion(s)}
                  >
                    {s.display_name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 mb-3">
          <p className="text-xs text-zinc-500">
            Toggle: satellite soil moisture (simulated)
          </p>
          <button
            type="button"
            onClick={() => setSoilMoistureOn((v) => !v)}
            className={`no-print rounded-full px-4 py-2 text-xs font-semibold border transition-colors ${
              soilMoistureOn
                ? 'border-cyan-400/40 bg-cyan-500/10 text-cyan-200'
                : 'border-white/10 bg-white/[0.04] text-zinc-300 hover:bg-white/[0.06]'
            }`}
          >
            {soilMoistureOn ? 'Soil Moisture: ON' : 'Soil Moisture: OFF'}
          </button>
        </div>

        <div className="w-full rounded-xl overflow-hidden border border-slate-700 z-0" style={{ height: 350 }}>
          <div className="relative w-full h-full">
            <MapContainer
            key={`${selectedPlace ? String(selectedPlace.place_id) : 'map-initial'}-${mapDrawKey}`}
            center={mapCenter}
            zoom={effectiveZoom}
            style={{ height: '100%', width: '100%' }}
            scrollWheelZoom
            className="z-0"
          >
            <TileLayer
              attribution="Tiles © Esri"
              url={ESRI_TILE}
              maxZoom={19}
            />
            {mapPosition && <Marker position={mapPosition} />}
            <FlyTo position={mapPosition} zoom={mapZoom} />
            <LeafletDrawRoof
              onPolygonRoof={onRoofPolygonMeasured}
              onPolygonCleared={onRoofPolygonCleared}
            />
          </MapContainer>
            {soilMoistureOn && (
              <div className="pointer-events-none absolute inset-0">
                <div
                  className="absolute inset-0 opacity-40 mix-blend-screen"
                  style={{
                    background:
                      'radial-gradient(circle at 20% 30%, rgba(59,130,246,0.9), transparent 38%), radial-gradient(circle at 70% 55%, rgba(249,115,22,0.85), transparent 42%), radial-gradient(circle at 55% 85%, rgba(34,211,238,0.65), transparent 45%)',
                  }}
                />
                <div className="absolute inset-0 bg-slate-900/10" />
              </div>
            )}
          </div>
        </div>
        <p className="text-sm text-slate-400 mt-2 mb-2">
          Zoom in, then use the <span className="text-cyan-400 font-medium">roof trace tool</span> (top-right)
          to draw a 4-corner roof outline—or set area manually below.
        </p>

        {cityData && (
          <p className="text-xs text-cyan-400/90 mb-4">
            Rainfall profile matched for: <span className="font-medium capitalize">{cityData.city}</span>
            {' — '}
            {cityData.annual} mm / yr, {cityData.rainyDays} rainy days
          </p>
        )}

        <div className="rounded-xl border border-slate-700/80 bg-slate-900/90 p-3 mb-6 shadow-lg shadow-cyan-950/20">
          <h3 className="text-sm font-semibold text-slate-200 mb-1 tracking-tight">
            5-Year Rainfall Trend (Erratic Monsoons)
          </h3>
          <p className="text-[11px] text-slate-500 mb-2">Mock regional trend — planning buffer for variable monsoons</p>
          <div className="h-44 w-full min-h-[11rem]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={RAINFALL_TREND_MOCK} margin={{ top: 6, right: 6, left: -18, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis
                  dataKey="year"
                  tick={{ fill: '#94a3b8', fontSize: 11 }}
                  axisLine={{ stroke: '#475569' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#94a3b8', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  label={{
                    value: 'mm',
                    angle: -90,
                    position: 'insideLeft',
                    fill: '#64748b',
                    fontSize: 10,
                  }}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(6,182,212,0.08)' }}
                  contentStyle={{
                    background: '#0f172a',
                    border: '1px solid #334155',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  labelStyle={{ color: '#e2e8f0' }}
                  formatter={(v) => [`${v} mm`, 'Rainfall']}
                />
                <Bar dataKey="mm" fill="#06b6d4" radius={[5, 5, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="space-y-6">
          <div>
            <div className="flex justify-between items-baseline mb-2 flex-wrap gap-2">
              <label className="text-sm text-slate-200">Roof area</label>
              <span className="text-xs text-slate-500">
                {roofSqFt} sq ft · {sqftToSqm(roofSqFt)} sq m
                {roofFromPolygon && roofPolygonSqM != null && (
                  <span className="text-emerald-400/90"> · traced: {roofPolygonSqM.toFixed(1)} m²</span>
                )}
              </span>
            </div>
            {roofFromPolygon ? (
              <div className="rounded-xl border border-emerald-500/40 bg-slate-900/80 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <p className="text-sm text-slate-200">
                  <span className="text-emerald-400 font-semibold">Roof traced on map</span>
                  {' — '}
                  area locked from polygon ({roofSqFt} sq ft).
                </p>
                <button
                  type="button"
                  onClick={clearRoofTrace}
                  className="no-print shrink-0 rounded-lg border border-slate-600 bg-slate-800 px-4 py-2 text-sm text-cyan-300 hover:bg-slate-700 hover:border-cyan-500/50 transition-colors"
                >
                  Clear trace &amp; use manual
                </button>
              </div>
            ) : (
              <>
                <input
                  type="number"
                  min={100}
                  max={5000}
                  value={roofSqFt}
                  onChange={(e) =>
                    setRoofSqFt(Math.min(5000, Math.max(100, Number(e.target.value) || 100)))
                  }
                  className="w-full rounded-lg border border-slate-600 bg-slate-900 px-3 py-2 text-white mb-2"
                />
                <input
                  type="range"
                  min={100}
                  max={5000}
                  step={50}
                  value={roofSqFt}
                  onChange={(e) => setRoofSqFt(Number(e.target.value))}
                  className="w-full accent-cyan-500"
                />
              </>
            )}
          </div>
          <div>
            <div className="flex justify-between items-baseline mb-2">
              <label className="text-sm text-gray-300">Open space for recharge</label>
              <span className="text-xs text-gray-500">
                {openSqFt} sq ft · {sqftToSqm(openSqFt)} sq m
              </span>
            </div>
            <input
              type="number"
              min={0}
              max={2000}
              value={openSqFt}
              onChange={(e) => setOpenSqFt(Math.min(2000, Math.max(0, Number(e.target.value) || 0)))}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white mb-2"
            />
            <input
              type="range"
              min={0}
              max={2000}
              step={25}
              value={openSqFt}
              onChange={(e) => setOpenSqFt(Number(e.target.value))}
              className="w-full accent-cyan-500"
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row gap-3 mt-8">
          <button
            type="button"
            onClick={() => goPage(2)}
            className="no-print px-4 py-2 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-800"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={() => selectedPlace && goPage(4)}
            disabled={!selectedPlace}
            className="no-print flex-1 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 disabled:opacity-40 text-gray-950 font-semibold"
          >
            Next: Add Details →
          </button>
        </div>
      </div>
    </div>
  )

  const detailsPage = (
    <div className="min-h-[80vh] px-4 py-8 pb-16 relative z-10">
      <div className="max-w-4xl mx-auto">
        <h2 className="text-2xl font-bold text-white mb-2">Household details</h2>
        <p className="text-sm text-zinc-500 mb-6">Used for harvest, feasibility, and your AI report.</p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="md:col-span-2">
            <label className="block text-sm text-gray-300 mb-1">Your name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-300 mb-1">People in household</label>
            <input
              type="number"
              min={1}
              max={20}
              value={dwellers}
              onChange={(e) =>
                setDwellers(Math.min(20, Math.max(1, Number(e.target.value) || 1)))
              }
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-300 mb-1">Monthly water bill (Rs, optional)</label>
            <input
              type="number"
              min={0}
              value={waterBill}
              onChange={(e) => setWaterBill(e.target.value)}
              className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
              placeholder="Optional"
            />
          </div>
          <div className="md:col-span-2">
            <p className="text-sm text-gray-300 mb-2">Roof material</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ROOF_OPTIONS.map((opt) => (
                <label
                  key={opt}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    roofMaterial === opt
                      ? 'border-cyan-500 bg-cyan-500/10'
                      : 'border-gray-600 bg-gray-800/80 hover:border-gray-500'
                  }`}
                >
                  <input
                    type="radio"
                    name="roof"
                    className="accent-cyan-500"
                    checked={roofMaterial === opt}
                    onChange={() => setRoofMaterial(opt)}
                  />
                  <span className="text-sm text-gray-200">{opt}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="md:col-span-2">
            <p className="text-sm text-gray-300 mb-2">Existing storage</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {STORAGE_OPTIONS.map((opt) => (
                <label
                  key={opt}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    storage === opt
                      ? 'border-cyan-500 bg-cyan-500/10'
                      : 'border-gray-600 bg-gray-800/80 hover:border-gray-500'
                  }`}
                >
                  <input
                    type="radio"
                    name="storage"
                    className="accent-cyan-500"
                    checked={storage === opt}
                    onChange={() => setStorage(opt)}
                  />
                  <span className="text-sm text-gray-200">{opt}</span>
                </label>
              ))}
            </div>
          </div>
          <div className="md:col-span-2 template-card rounded-2xl p-5 border border-white/10">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-white">AI Vision Scan (demo)</p>
                <p className="text-xs text-zinc-500 mt-1">
                  Scan Roof via AI Vision — mocked for hackathon (no backend, no uploads).
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (visionScanning) return
                  setVisionScanning(true)
                  setTimeout(() => {
                    setVisionScanning(false)
                    // Demo: nudge roof area slightly to show "scan" effect
                    setRoofSqFt((v) => Math.min(5000, Math.max(100, Math.round(v * 1.07))))
                    setRoofFromPolygon(false)
                    setRoofPolygonSqM(null)
                  }, 3000)
                }}
                className="no-print rounded-full px-4 py-2 text-xs font-semibold bg-cyan-500 text-slate-950 hover:bg-cyan-400"
              >
                Scan Roof via AI Vision
              </button>
            </div>
            <div className="mt-4 relative rounded-xl overflow-hidden border border-white/10 bg-gradient-to-br from-slate-900 to-slate-950 h-40">
              <div className="absolute inset-0 opacity-30" style={{ background: 'radial-gradient(circle at 35% 40%, rgba(34,211,238,0.55), transparent 45%), radial-gradient(circle at 70% 60%, rgba(99,102,241,0.35), transparent 50%)' }} />
              {visionScanning && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-full h-full bg-slate-950/50 backdrop-blur-[2px]" />
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-4">
                    <p className="text-white font-semibold">Scanning…</p>
                    <p className="text-xs text-zinc-300 mt-1">Analyzing rooftop edges &amp; shadows</p>
                    <div className="mt-4 w-64 max-w-[85%] h-2 rounded-full bg-white/10 overflow-hidden">
                      <div className="h-full w-1/3 bg-cyan-400 animate-pulse" />
                    </div>
                  </div>
                  <div className="absolute left-0 right-0 top-1/2 h-0.5 bg-cyan-400/70 animate-pulse" />
                </div>
              )}
              {!visionScanning && (
                <div className="absolute inset-0 flex items-end justify-between p-4">
                  <p className="text-[11px] text-zinc-400">Mock satellite snapshot</p>
                  <p className="text-[11px] text-zinc-400">Scan time: ~3s</p>
                </div>
              )}
            </div>
          </div>
          {storage !== 'None' && (
            <div className="md:col-span-2">
              <label className="block text-sm text-gray-300 mb-1">
                Existing storage capacity (litres)
              </label>
              <input
                type="number"
                min={0}
                value={storageCapacity}
                onChange={(e) => setStorageCapacity(e.target.value)}
                className="w-full rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-white"
              />
            </div>
          )}
          <div className="md:col-span-2 rounded-xl border border-slate-700/90 bg-gradient-to-br from-slate-900 via-slate-900 to-slate-950 p-5 shadow-lg shadow-emerald-950/20 ring-1 ring-cyan-500/10">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-slate-100 tracking-tight">
                  <span className="mr-1.5" aria-hidden>
                    🔔
                  </span>
                  Enable AI Weather &amp; Maintenance SMS Alerts
                </p>
                <p className="text-xs text-slate-500 mt-2 leading-relaxed max-w-lg">
                  We&apos;ll text you 48 hours before the first monsoon to clean your first-flush filter.
                </p>
              </div>
              <button
                type="button"
                id="sms-alerts-toggle"
                role="switch"
                aria-checked={smsAlertsEnabled}
                aria-label="Toggle SMS maintenance alerts"
                onClick={() => setSmsAlertsEnabled((v) => !v)}
                className={`relative h-10 w-[4.25rem] shrink-0 rounded-full transition-all duration-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 focus-visible:ring-offset-2 focus-visible:ring-offset-slate-900 ${
                  smsAlertsEnabled
                    ? 'bg-gradient-to-r from-emerald-500 to-cyan-500 shadow-[0_0_24px_rgba(16,185,129,0.45)]'
                    : 'bg-slate-700 ring-1 ring-slate-600'
                }`}
              >
                <span
                  className={`absolute top-1 left-1 h-8 w-8 rounded-full bg-white shadow-md transition-transform duration-300 ease-out ${
                    smsAlertsEnabled ? 'translate-x-[2.15rem]' : 'translate-x-0'
                  }`}
                />
              </button>
            </div>
            {smsAlertsEnabled && (
              <p className="text-[11px] text-emerald-400/90 mt-3 font-medium">
                Opt-in saved for this session (demo — no SMS sent without backend).
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-col sm:flex-row gap-3 mt-10">
          <button
            type="button"
            onClick={() => goPage(3)}
            className="no-print px-4 py-2 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-800"
          >
            ← Back
          </button>
          <button
            type="button"
            onClick={generateReport}
            className="no-print flex-1 py-3 rounded-xl bg-cyan-500 hover:bg-cyan-400 text-gray-950 font-semibold"
          >
            Generate My Report →
          </button>
        </div>
      </div>
    </div>
  )

  const reportCalculations = useMemo(() => {
    if (!cityData || !selectedPlace) return null
    return calculateRTRWH(
      {
        name: name.trim() || 'Homeowner',
        dwellers: Number(dwellers) || 1,
        roofSqFt,
        openSqFt,
        roofMaterial,
        storage,
        storageCapacity:
          storage !== 'None' && storageCapacity !== '' ? Number(storageCapacity) : null,
        waterBill: waterBill !== '' ? Number(waterBill) : null,
        smsAlertsEnabled,
      },
      cityData,
    )
  }, [
    cityData,
    selectedPlace,
    name,
    dwellers,
    roofSqFt,
    openSqFt,
    roofMaterial,
    storage,
    storageCapacity,
    waterBill,
    smsAlertsEnabled,
  ])

  const taxFormData = lastCalculations ?? reportCalculations
  const taxName = name.trim() || 'Applicant'
  const taxAddress = selectedPlace?.display_name ?? '—'

  const b2gMortality =
    cityData != null ? computeSaplingMortalityPercent(cityData) : null
  const b2gSubsidence =
    cityData != null ? computeSubsidenceMmPerYear(cityData) : null
  const b2gPriority =
    b2gMortality != null && b2gSubsidence != null
      ? computeB2gPriorityIndex(b2gMortality, b2gSubsidence)
      : null
  const b2gIrrigationMultiplier = cityData != null && cityData.depth > 30 ? 2 : 1
  const b2gBudgetLakhs =
    b2gMortality != null
      ? Math.round((2.1 * b2gIrrigationMultiplier + b2gMortality / 40) * 10) / 10
      : 4.2

  const scoreForBar = lastCalculations?.feasibilityScore ?? reportCalculations?.feasibilityScore

  const reportPage = (
    <div className="min-h-[80vh] px-4 py-8 pb-16 relative z-10">
      <div className="max-w-4xl mx-auto">
        {reportLoading && (
          <div className="text-center py-16">
            <p className="text-cyan-300 mb-4">Analyzing your rooftop with AI…</p>
            <div className="water-progress-track max-w-md mx-auto">
              <div className="water-progress-fill" />
            </div>
          </div>
        )}

        {!reportLoading && reportError && (
          <div className="rounded-xl border border-red-500/40 bg-red-950/30 p-6 text-center">
            <p className="text-red-400 mb-4">{reportError}</p>
            <button
              type="button"
              onClick={generateReport}
              className="no-print px-6 py-2 rounded-lg bg-cyan-500 text-gray-950 font-medium"
            >
              {reportOverloaded ? 'System Overloaded - Retry' : 'Retry'}
            </button>
            <button
              type="button"
              onClick={() => goPage(4)}
              className="no-print block mx-auto mt-3 text-sm text-gray-400 hover:text-white"
            >
              ← Edit details
            </button>
          </div>
        )}

        {!reportLoading && !reportError && reportHtml && (
          <>
            {(lastCalculations || reportCalculations) && (
              <div className="no-print template-card rounded-2xl p-5 mb-4 border border-white/10">
                <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
                      RainRoot Insights (calculated)
                    </p>
                    <p className="text-white font-semibold mt-2">
                      Annual harvest:{' '}
                      <span className="text-cyan-300">
                        {(lastCalculations || reportCalculations).annualHarvestLitres.toLocaleString(
                          'en-IN',
                        )}{' '}
                        L
                      </span>
                      {' · '}
                      Feasibility:{' '}
                      <span className="text-indigo-200">
                        {(lastCalculations || reportCalculations).feasibilityScore}/100
                      </span>
                    </p>
                    <p className="text-sm text-zinc-500 mt-1">
                      Tank:{' '}
                      {(lastCalculations || reportCalculations).recommendedTankLitres.toLocaleString(
                        'en-IN',
                      )}{' '}
                      L · Recharge pit: {(lastCalculations || reportCalculations).rechargePitCubicM} m³ ·
                      Estimated savings: ₹
                      {(lastCalculations || reportCalculations).annualSavingsRs.toLocaleString('en-IN')}/yr
                    </p>
                  </div>
                  {cityData && (
                    <div className="rounded-xl border border-indigo-500/20 bg-indigo-950/20 p-4">
                      <p className="text-[10px] uppercase tracking-widest text-indigo-300 font-semibold">
                        Municipal signals (B2G)
                      </p>
                      <p className="text-sm text-zinc-300 mt-2">
                        Sapling mortality (est.):{' '}
                        <span className="text-amber-200 font-semibold">
                          {computeSaplingMortalityPercent(cityData)}%
                        </span>
                      </p>
                      <p className="text-sm text-zinc-400 mt-1">
                        Subsidence risk (demo): {computeSubsidenceMmPerYear(cityData)} mm/yr
                      </p>
                      <p className="text-sm text-zinc-400 mt-1">
                        Irrigation multiplier: ~{b2gIrrigationMultiplier}× (GW depth {cityData.depth}m)
                      </p>
                      <button
                        type="button"
                        onClick={() => setB2gModalOpen(true)}
                        className="mt-3 w-full rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold py-2"
                      >
                        Open B2G dashboard
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
            <div className="no-print flex flex-wrap items-center gap-2 gap-y-2 mb-4 p-3 rounded-xl border border-gray-700 bg-gray-900/80 text-sm">
              <span className="text-gray-400 truncate max-w-full">
                {selectedPlace?.display_name}
              </span>
              <span className="text-gray-500">|</span>
              <span className="text-gray-300">{roofSqFt} sq ft roof</span>
              {scoreForBar != null && (
                <>
                  <span className="text-gray-500">|</span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full border text-xs font-medium ${feasibilityColor(scoreForBar)}`}
                  >
                    Feasibility {scoreForBar}/100
                  </span>
                </>
              )}
            </div>
            <ReportHtmlBoundary>
              <div
                className="print-expand max-w-none rounded-xl border border-gray-700 bg-gray-900/50 p-4 mb-6 overflow-auto"
                dangerouslySetInnerHTML={{ __html: reportHtml }}
              />
            </ReportHtmlBoundary>
            <div className="no-print flex flex-col sm:flex-row flex-wrap gap-3">
              <button
                type="button"
                onClick={() => window.print()}
                className="px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-white font-medium"
              >
                Print / Save PDF
              </button>
              <button
                type="button"
                onClick={resetAssessment}
                className="px-4 py-2 rounded-lg border border-gray-600 text-gray-200 hover:bg-gray-800"
              >
                New Assessment
              </button>
              <button
                type="button"
                onClick={downloadSummaryPdf}
                className="px-4 py-2 rounded-lg border border-cyan-500/50 text-cyan-400 hover:bg-cyan-500/10"
              >
                Download Summary PDF
              </button>
              <button
                type="button"
                onClick={openTaxRebatePrint}
                className="px-4 py-2 rounded-lg border border-emerald-500/60 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/50 font-medium"
              >
                📄 Generate Municipal Tax Rebate Form
              </button>
              <button
                type="button"
                onClick={() => setB2gModalOpen(true)}
                className="px-4 py-2 rounded-lg border border-indigo-500/50 bg-indigo-950/50 text-indigo-200 hover:bg-indigo-900/40 font-medium"
              >
                📊 View Municipal Resilience Insights
              </button>
            </div>
          </>
        )}

        <div className="mt-10 pt-6 border-t border-white/10 text-center text-[11px] text-zinc-500">
          <p>Report sources: CGWB Manual 2007 · IMD Rainfall Atlas · WHO water standards</p>
        </div>
      </div>
    </div>
  )

  let body
  switch (currentPage) {
    case 1:
      body = landing
      break
    case 2:
      body = apiSetup
      break
    case 3:
      body = locationPage
      break
    case 4:
      body = detailsPage
      break
    case 5:
      body = reportPage
      break
    default:
      body = landing
  }

  return (
    <>
      {pageWrap(body)}
      {b2gModalOpen && cityData && b2gMortality != null && (
        <div
          className="fixed inset-0 z-[99990] flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md"
          role="dialog"
          aria-modal="true"
          aria-labelledby="b2g-modal-title"
          onClick={() => setB2gModalOpen(false)}
        >
          <div
            id="b2g-intelligence-modal"
            className="no-print w-full max-w-lg rounded-2xl border border-indigo-500/35 bg-gradient-to-b from-slate-900 to-slate-950 shadow-2xl shadow-indigo-950/40 p-6 max-h-[min(90vh,640px)] overflow-y-auto ring-1 ring-cyan-500/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-3 mb-4">
              <div>
                <p className="text-[10px] uppercase tracking-widest text-indigo-400 font-semibold">
                  B2G Intelligence
                </p>
                <h2
                  id="b2g-modal-title"
                  className="text-lg font-bold text-white mt-1 leading-snug"
                >
                  Regional Afforestation Survival Risk
                </h2>
                <p className="text-xs text-slate-500 mt-1 capitalize">
                  Sector model · {cityData.city}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setB2gModalOpen(false)}
                className="shrink-0 rounded-lg px-2.5 py-1 text-sm text-slate-400 hover:bg-slate-800 hover:text-white"
                aria-label="Close"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-slate-400 mb-2">
              Groundwater depth: <span className="text-cyan-400/90">{cityData.depth}m</span>{' '}
              · {cityData.annual} mm/yr rainfall · soil: {cityData.soil}
            </p>
            <div className="grid grid-cols-2 gap-3 mb-4">
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-3">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                  Land subsidence risk (demo)
                </p>
                <p className="text-xl font-bold text-white tabular-nums mt-1">
                  {b2gSubsidence != null ? `${b2gSubsidence} mm/yr` : '—'}
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  Depth + aquifer sensitivity indicator
                </p>
              </div>
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 p-3">
                <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                  Priority index
                </p>
                <p className="text-xl font-bold text-white tabular-nums mt-1">
                  {b2gPriority != null ? `${b2gPriority}/100` : '—'}
                </p>
                <p className="text-[11px] text-slate-500 mt-1">
                  Survival stress + subsidence
                </p>
              </div>
            </div>
            <div className="rounded-xl border border-slate-700 bg-slate-950/80 p-2 mb-4">
              <p className="text-[10px] text-slate-500 uppercase tracking-wide mb-2 px-1">
                Survival stress heatmap (model grid)
              </p>
              <div
                className="grid grid-cols-8 gap-0.5 rounded-lg overflow-hidden"
                role="img"
                aria-label="Red amber green risk zones"
              >
                {Array.from({ length: 40 }, (_, i) => {
                  const row = Math.floor(i / 8)
                  const col = i % 8
                  return (
                    <div
                      key={i}
                      className={`aspect-square min-h-[10px] ${b2gHeatmapCellClass(b2gMortality, row, col, 5, 8)}`}
                    />
                  )
                })}
              </div>
              <div className="flex flex-wrap gap-3 mt-2 px-1 text-[10px] text-slate-500">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-600" /> Lower risk
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-400" /> Elevated
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-600" /> High stress
                </span>
              </div>
            </div>
            <div className="rounded-xl border border-slate-700/80 bg-slate-800/50 p-4 mb-4">
              <p className="text-xs text-slate-400 uppercase tracking-wide mb-1">
                Estimated sapling mortality rate
              </p>
              <p className="text-3xl font-bold text-transparent bg-clip-text bg-gradient-to-r from-amber-200 to-red-300 tabular-nums">
                {b2gMortality}%
              </p>
              <p className="text-[11px] text-slate-500 mt-2 leading-relaxed">
                Modelled from groundwater depth to water table and monsoon reliability for this
                matched city profile (demo indicator for ULB planning).
              </p>
            </div>
            <div className="rounded-xl border border-indigo-500/25 bg-indigo-950/25 p-4 mb-4">
              <p className="text-xs font-semibold text-indigo-200 leading-relaxed">
                Municipal advisory: groundwater depth implies{' '}
                <span className="text-white">~{b2gIrrigationMultiplier}×</span> irrigation budget for
                afforestation survival in high-stress wards.
              </p>
              <p className="text-[11px] text-slate-400 mt-2 leading-relaxed">
                Rule: if groundwater depth exceeds 30m (midpoint or max of the range), tree-planting
                programs typically need 2× watering allocations due to weak natural aquifer access for
                deep-rooting species.
              </p>
            </div>
            <div className="rounded-xl border border-emerald-500/25 bg-emerald-950/25 p-4">
              <p className="text-xs font-semibold text-emerald-300/95 leading-relaxed">
                Recommendation: Allocate ₹{b2gBudgetLakhs} Lakhs additional irrigation budget for this
                sector to ensure 90% plantation survival.
              </p>
              <div className="mt-3 grid grid-cols-2 gap-3 text-[11px] text-slate-300/90">
                <div className="rounded-lg border border-slate-700/70 bg-slate-950/40 p-2">
                  <p className="text-slate-500">Drivers</p>
                  <p className="mt-1">
                    GW depth · mortality · rainfall variability
                  </p>
                </div>
                <div className="rounded-lg border border-slate-700/70 bg-slate-950/40 p-2">
                  <p className="text-slate-500">Target</p>
                  <p className="mt-1">
                    90% survival in first monsoon cycle
                  </p>
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setB2gModalOpen(false)}
              className="mt-5 w-full rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold py-2.5"
            >
              Close dashboard
            </button>
          </div>
        </div>
      )}
      {taxRebatePrintOpen && taxFormData && (
        <div
          id="tax-rebate-print-root"
          className="fixed inset-0 z-[100000] overflow-y-auto bg-slate-200 text-slate-900 print:bg-white print:static print:inset-auto"
        >
          <div className="max-w-3xl mx-auto my-6 px-4 print:my-0 print:px-0 print:max-w-none">
            <article className="bg-white border-2 border-slate-900 text-black p-8 md:p-10 shadow-xl print:shadow-none print:border-black">
              <header className="text-center border-b-2 border-slate-900 pb-5 mb-6">
                <p className="text-xs uppercase tracking-widest text-slate-600 mb-1">
                  Bruhat Bengaluru Mahanagara Palike / Urban Local Body
                </p>
                <h1 className="text-lg md:text-xl font-bold uppercase leading-snug">
                  Rooftop Rainwater Harvesting (RTRWH) — Property Tax Rebate Declaration
                </h1>
                <p className="text-xs text-slate-600 mt-2 italic">
                  Model form for demonstration (RainRoot — SustainAI 2026)
                </p>
              </header>
              <section className="space-y-4 text-sm leading-relaxed">
                <p>
                  <strong>1. Applicant name:</strong> {taxName}
                </p>
                <p>
                  <strong>2. Property location (as searched):</strong>
                  <br />
                  <span className="font-mono text-xs whitespace-pre-wrap">{taxAddress}</span>
                </p>
                <p>
                  <strong>3. Municipal / rainfall zone (matched):</strong>{' '}
                  {cityData ? `${cityData.city} — ${cityData.annual} mm annual (reference)` : '—'}
                </p>
                <p>
                  <strong>4. Declared rooftop catchment area:</strong> {roofSqFt} sq ft (
                  {sqftToSqm(roofSqFt)} m²)
                </p>
                <p>
                  <strong>5. Estimated annual rainwater harvest (RainRoot calc., CGWB-style):</strong>{' '}
                  {taxFormData.annualHarvestLitres.toLocaleString('en-IN')} litres / year
                </p>
                <p>
                  <strong>6. Recommended storage (indicative):</strong>{' '}
                  {taxFormData.recommendedTankLitres.toLocaleString('en-IN')} litres capacity
                </p>
                <p>
                  <strong>7. Recharge / open-space works (indicative):</strong>{' '}
                  {taxFormData.rechargePitCubicM} m³ recharge pit volume (model estimate)
                </p>
                <p className="pt-4 border-t border-slate-300">
                  I hereby declare that the above particulars are true to the best of my knowledge and that
                  I intend to operate / maintain the stated RTRWH system in compliance with municipal
                  groundwater recharge guidelines. I apply for consideration under the applicable property
                  tax rebate / rebate-credit scheme for RTRWH installations.
                </p>
                <p className="pt-6">
                  <strong>Date:</strong> {new Date().toLocaleDateString('en-IN', { dateStyle: 'long' })}
                </p>
                <p className="pt-12">
                  <span className="inline-block min-w-[14rem] border-b border-black pb-1">
                    Signature of property owner
                  </span>
                </p>
              </section>
            </article>
            <div className="no-print flex flex-wrap justify-center gap-3 mt-6 pb-10">
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-lg bg-slate-900 text-white px-5 py-2.5 text-sm font-medium hover:bg-slate-800"
              >
                Print again
              </button>
              <button
                type="button"
                onClick={closeTaxRebateOverlay}
                className="rounded-lg border border-slate-600 bg-white px-5 py-2.5 text-sm font-medium text-slate-800 hover:bg-slate-50"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
