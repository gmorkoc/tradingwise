import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "../styles/Watchlist.css";

interface CatalogEntry { id: string; symbol: string; name: string }

interface PriceEntry { price: number; pct: number; vol: number }

// Some symbols trade under a different name on Binance
const BINANCE_OVERRIDE: Record<string, string> = {
  POL:   "MATIC",  // Polygon still lists as MATIC
  MIOTA: "IOTA",
};

function toBinanceSym(symbol: string): string {
  return (BINANCE_OVERRIDE[symbol] ?? symbol) + "USDT";
}

async function fetchBinancePrices(symbols: string[]): Promise<Map<string, PriceEntry>> {
  try {
    const res = await fetch(
      "https://data-api.binance.vision/api/v3/ticker/24hr",
      { signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return new Map();
    const all: { symbol: string; lastPrice: string; priceChangePercent: string; quoteVolume: string }[] =
      await res.json();
    const lookup = new Map(all.map(t => [t.symbol, t]));
    const result = new Map<string, PriceEntry>();
    for (const sym of symbols) {
      const t = lookup.get(toBinanceSym(sym));
      if (t) result.set(sym, {
        price: parseFloat(t.lastPrice),
        pct:   parseFloat(t.priceChangePercent),
        vol:   parseFloat(t.quoteVolume),
      });
    }
    return result;
  } catch { return new Map(); }
}

async function fetchSparklines(symbols: string[]): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>();
  await Promise.all(symbols.map(async sym => {
    try {
      const res = await fetch(
        `https://data-api.binance.vision/api/v3/klines?symbol=${toBinanceSym(sym)}&interval=1d&limit=7`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!res.ok) return;
      const data: (string | number)[][] = await res.json();
      result.set(sym, data.map(c => parseFloat(String(c[4])))); // close prices
    } catch { /* symbol may not exist on Binance */ }
  }));
  return result;
}

const CATALOG: CatalogEntry[] = [
  // ── Layer 1 ──────────────────────────────────────────────────────────────
  { id: "bitcoin",                   symbol: "BTC",    name: "Bitcoin"             },
  { id: "ethereum",                  symbol: "ETH",    name: "Ethereum"            },
  { id: "binancecoin",               symbol: "BNB",    name: "BNB"                 },
  { id: "ripple",                    symbol: "XRP",    name: "XRP"                 },
  { id: "solana",                    symbol: "SOL",    name: "Solana"              },
  { id: "cardano",                   symbol: "ADA",    name: "Cardano"             },
  { id: "dogecoin",                  symbol: "DOGE",   name: "Dogecoin"            },
  { id: "tron",                      symbol: "TRX",    name: "TRON"                },
  { id: "avalanche-2",               symbol: "AVAX",   name: "Avalanche"           },
  { id: "the-open-network",          symbol: "TON",    name: "Toncoin"             },
  { id: "polkadot",                  symbol: "DOT",    name: "Polkadot"            },
  { id: "bitcoin-cash",              symbol: "BCH",    name: "Bitcoin Cash"        },
  { id: "near",                      symbol: "NEAR",   name: "NEAR Protocol"       },
  { id: "litecoin",                  symbol: "LTC",    name: "Litecoin"            },
  { id: "internet-computer",         symbol: "ICP",    name: "Internet Computer"   },
  { id: "aptos",                     symbol: "APT",    name: "Aptos"               },
  { id: "sui",                       symbol: "SUI",    name: "Sui"                 },
  { id: "ethereum-classic",          symbol: "ETC",    name: "Ethereum Classic"    },
  { id: "cosmos",                    symbol: "ATOM",   name: "Cosmos"              },
  { id: "hedera-hashgraph",          symbol: "HBAR",   name: "Hedera"              },
  { id: "stellar",                   symbol: "XLM",    name: "Stellar"             },
  { id: "monero",                    symbol: "XMR",    name: "Monero"              },
  { id: "kaspa",                     symbol: "KAS",    name: "Kaspa"               },
  { id: "vechain",                   symbol: "VET",    name: "VeChain"             },
  { id: "eos",                       symbol: "EOS",    name: "EOS"                 },
  { id: "algorand",                  symbol: "ALGO",   name: "Algorand"            },
  { id: "dash",                      symbol: "DASH",   name: "Dash"                },
  { id: "zcash",                     symbol: "ZEC",    name: "Zcash"               },
  { id: "iota",                      symbol: "MIOTA",  name: "IOTA"                },
  { id: "neo",                       symbol: "NEO",    name: "Neo"                 },
  { id: "fantom",                    symbol: "FTM",    name: "Fantom"              },
  { id: "elrond-erd-2",              symbol: "EGLD",   name: "MultiversX"          },
  { id: "harmony",                   symbol: "ONE",    name: "Harmony"             },
  { id: "kava",                      symbol: "KAVA",   name: "Kava"                },
  { id: "bittensor",                 symbol: "TAO",    name: "Bittensor"           },
  { id: "ronin",                     symbol: "RON",    name: "Ronin"               },
  { id: "ondo-finance",              symbol: "ONDO",   name: "Ondo"                },
  { id: "bitcoin-sv",                symbol: "BSV",    name: "Bitcoin SV"          },
  { id: "waves",                     symbol: "WAVES",  name: "Waves"               },
  { id: "zilliqa",                   symbol: "ZIL",    name: "Zilliqa"             },
  { id: "icon",                      symbol: "ICX",    name: "ICON"                },
  { id: "ontology",                  symbol: "ONT",    name: "Ontology"            },
  // ── Layer 2 / Scaling ────────────────────────────────────────────────────
  { id: "matic-network",             symbol: "POL",    name: "Polygon"             },
  { id: "arbitrum",                  symbol: "ARB",    name: "Arbitrum"            },
  { id: "optimism",                  symbol: "OP",     name: "Optimism"            },
  { id: "starknet",                  symbol: "STRK",   name: "Starknet"            },
  { id: "immutable-x",               symbol: "IMX",    name: "Immutable"           },
  { id: "mantle",                    symbol: "MNT",    name: "Mantle"              },
  { id: "loopring",                  symbol: "LRC",    name: "Loopring"            },
  { id: "metis-token",               symbol: "METIS",  name: "Metis"               },
  // ── DeFi ─────────────────────────────────────────────────────────────────
  { id: "chainlink",                 symbol: "LINK",   name: "Chainlink"           },
  { id: "uniswap",                   symbol: "UNI",    name: "Uniswap"             },
  { id: "aave",                      symbol: "AAVE",   name: "Aave"                },
  { id: "maker",                     symbol: "MKR",    name: "Maker"               },
  { id: "curve-dao-token",           symbol: "CRV",    name: "Curve"               },
  { id: "compound-governance-token", symbol: "COMP",   name: "Compound"            },
  { id: "yearn-finance",             symbol: "YFI",    name: "yearn.finance"       },
  { id: "synthetix-network-token",   symbol: "SNX",    name: "Synthetix"           },
  { id: "lido-dao",                  symbol: "LDO",    name: "Lido DAO"            },
  { id: "pancakeswap-token",         symbol: "CAKE",   name: "PancakeSwap"         },
  { id: "1inch",                     symbol: "1INCH",  name: "1inch"               },
  { id: "sushi",                     symbol: "SUSHI",  name: "SushiSwap"           },
  { id: "balancer",                  symbol: "BAL",    name: "Balancer"            },
  { id: "dydx-chain",                symbol: "DYDX",   name: "dYdX"               },
  { id: "gmx",                       symbol: "GMX",    name: "GMX"                 },
  { id: "pendle",                    symbol: "PENDLE", name: "Pendle"              },
  { id: "thorchain",                 symbol: "RUNE",   name: "THORChain"           },
  { id: "the-graph",                 symbol: "GRT",    name: "The Graph"           },
  { id: "injective-protocol",        symbol: "INJ",    name: "Injective"           },
  { id: "convex-finance",            symbol: "CVX",    name: "Convex Finance"      },
  { id: "blur",                      symbol: "BLUR",   name: "Blur"                },
  { id: "ethena",                    symbol: "ENA",    name: "Ethena"              },
  { id: "hyperliquid",               symbol: "HYPE",   name: "Hyperliquid"         },
  { id: "raydium",                   symbol: "RAY",    name: "Raydium"             },
  { id: "jupiter-exchange-solana",   symbol: "JUP",    name: "Jupiter"             },
  { id: "jito-governance-token",     symbol: "JTO",    name: "Jito"                },
  // ── AI / Data / Infra ────────────────────────────────────────────────────
  { id: "fetch-ai",                  symbol: "FET",    name: "Fetch.ai"            },
  { id: "render-token",              symbol: "RNDR",   name: "Render"              },
  { id: "worldcoin-wld",             symbol: "WLD",    name: "Worldcoin"           },
  { id: "ocean-protocol",            symbol: "OCEAN",  name: "Ocean Protocol"      },
  { id: "grass",                     symbol: "GRASS",  name: "Grass"               },
  { id: "io-net",                    symbol: "IO",     name: "io.net"              },
  { id: "akash-network",             symbol: "AKT",    name: "Akash Network"       },
  { id: "singularitynet",            symbol: "AGIX",   name: "SingularityNET"      },
  { id: "pyth-network",              symbol: "PYTH",   name: "Pyth Network"        },
  { id: "wormhole",                  symbol: "W",      name: "Wormhole"            },
  { id: "celestia",                  symbol: "TIA",    name: "Celestia"            },
  { id: "eigenlayer",                symbol: "EIGEN",  name: "EigenLayer"          },
  { id: "filecoin",                  symbol: "FIL",    name: "Filecoin"            },
  { id: "helium",                    symbol: "HNT",    name: "Helium"              },
  { id: "storj",                     symbol: "STORJ",  name: "Storj"               },
  { id: "golem",                     symbol: "GLM",    name: "Golem"               },
  { id: "ankr",                      symbol: "ANKR",   name: "Ankr"                },
  // ── Oracles / Middleware ──────────────────────────────────────────────────
  { id: "basic-attention-token",     symbol: "BAT",    name: "Basic Attention"     },
  { id: "0x",                        symbol: "ZRX",    name: "0x Protocol"         },
  { id: "band-protocol",             symbol: "BAND",   name: "Band Protocol"       },
  { id: "api3",                      symbol: "API3",   name: "API3"                },
  // ── Gaming / NFT / Metaverse ─────────────────────────────────────────────
  { id: "axie-infinity",             symbol: "AXS",    name: "Axie Infinity"       },
  { id: "decentraland",              symbol: "MANA",   name: "Decentraland"        },
  { id: "the-sandbox",               symbol: "SAND",   name: "The Sandbox"         },
  { id: "gala",                      symbol: "GALA",   name: "Gala"                },
  { id: "flow",                      symbol: "FLOW",   name: "Flow"                },
  { id: "theta-token",               symbol: "THETA",  name: "Theta"               },
  { id: "enjincoin",                 symbol: "ENJ",    name: "Enjin Coin"          },
  { id: "chiliz",                    symbol: "CHZ",    name: "Chiliz"              },
  { id: "illuvium",                  symbol: "ILV",    name: "Illuvium"            },
  { id: "gods-unchained",            symbol: "GODS",   name: "Gods Unchained"      },
  { id: "superfarm",                 symbol: "SUPER",  name: "SuperVerse"          },
  // ── Memes ────────────────────────────────────────────────────────────────
  { id: "shiba-inu",                 symbol: "SHIB",   name: "Shiba Inu"           },
  { id: "pepe",                      symbol: "PEPE",   name: "Pepe"                },
  { id: "bonk",                      symbol: "BONK",   name: "Bonk"               },
  { id: "dogwifcoin",                symbol: "WIF",    name: "dogwifhat"           },
  { id: "floki",                     symbol: "FLOKI",  name: "Floki"               },
  { id: "cat-in-a-dogs-world",       symbol: "MEW",    name: "cat in a dogs world" },
  { id: "book-of-meme",              symbol: "BOME",   name: "Book of Meme"        },
  { id: "mog-coin",                  symbol: "MOG",    name: "Mog Coin"            },
  { id: "brett",                     symbol: "BRETT",  name: "Brett"               },
  { id: "degen-base",                symbol: "DEGEN",  name: "Degen"               },
  { id: "popcat",                    symbol: "POPCAT", name: "Popcat"              },
  { id: "dogs-token",                symbol: "DOGS",   name: "DOGS"                },
  { id: "notcoin",                   symbol: "NOT",    name: "Notcoin"             },
  { id: "baby-doge-coin",            symbol: "BABYDOGE",name: "Baby Doge Coin"     },
  // ── Ecosystem / Misc ─────────────────────────────────────────────────────
  { id: "sei-network",               symbol: "SEI",    name: "Sei"                 },
  { id: "berachain-bera",            symbol: "BERA",   name: "Berachain"           },
  { id: "rocket-pool",               symbol: "RPL",    name: "Rocket Pool"         },
  { id: "nervos-network",            symbol: "CKB",    name: "Nervos Network"      },
  { id: "qtum",                      symbol: "QTUM",   name: "Qtum"                },
];

const DEFAULT_IDS = ["bitcoin", "ethereum", "solana", "ripple"];

/* ── Sparkline ──────────────────────────────────────────────────────────── */
function Sparkline({ prices, positive }: { prices: number[]; positive: boolean }) {
  if (prices.length < 2) return null;
  const W = 60, H = 26;
  // Only downsample large series (e.g. CoinGecko 168-pt); Binance gives 7 pts already
  const sample = prices.length > 20 ? prices.filter((_, i) => i % 4 === 0) : prices;
  const min = Math.min(...sample);
  const max = Math.max(...sample);
  const range = max - min || 1;
  const pts = sample.map((p, i) => {
    const x = (i / (sample.length - 1)) * W;
    const y = H - ((p - min) / range) * (H - 4) - 2;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = positive ? "#22c55e" : "#ef4444";
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <polyline points={pts} fill="none" stroke={color}
        strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ── Helpers ────────────────────────────────────────────────────────────── */
function fmtPrice(p: number): string {
  if (p >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

function fmtVol(v: number): string {
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  return `${v.toFixed(0)}`;
}

/* ── Component ──────────────────────────────────────────────────────────── */
export function Watchlist() {
  const { t } = useTranslation();
  const [watchedIds, setWatchedIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("watchlistCoins_v1") ?? "null");
      return Array.isArray(saved) && saved.length > 0 ? saved : DEFAULT_IDS;
    } catch { return DEFAULT_IDS; }
  });
  const [priceData,  setPriceData]  = useState<Map<string, PriceEntry>>(new Map());
  const [sparklines, setSparklines] = useState<Map<string, number[]>>(new Map());
  const [loading,    setLoading]    = useState(true);
  const [search,     setSearch]     = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [imgErrors,  setImgErrors]  = useState<Set<string>>(new Set());
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem("watchlistCoins_v1", JSON.stringify(watchedIds));
  }, [watchedIds]);

  // Price refresh every 30s
  useEffect(() => {
    if (watchedIds.length === 0) { setLoading(false); return; }
    const symbols = watchedIds.map(id => CATALOG.find(c => c.id === id)?.symbol ?? "").filter(Boolean);

    async function refresh() {
      const data = await fetchBinancePrices(symbols);
      setPriceData(data);
      setLoading(false);
    }

    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [watchedIds]);

  // Sparklines refresh every 10 min (daily candles, no need to hammer)
  useEffect(() => {
    if (watchedIds.length === 0) return;
    const symbols = watchedIds.map(id => CATALOG.find(c => c.id === id)?.symbol ?? "").filter(Boolean);

    fetchSparklines(symbols).then(setSparklines);
    const id = setInterval(() => fetchSparklines(symbols).then(setSparklines), 10 * 60_000);
    return () => clearInterval(id);
  }, [watchedIds]);

  useEffect(() => {
    if (!searchOpen) return;
    const handle = (e: MouseEvent) => {
      if (!searchRef.current?.contains(e.target as Node)) {
        setSearchOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [searchOpen]);

  const addCoin = (id: string) => {
    if (!watchedIds.includes(id)) setWatchedIds(prev => [...prev, id]);
    setSearchOpen(false);
    setSearch("");
  };

  const removeCoin = (id: string) => setWatchedIds(prev => prev.filter(x => x !== id));

  const filteredCatalog = CATALOG.filter(c =>
    !watchedIds.includes(c.id) &&
    (c.name.toLowerCase().includes(search.toLowerCase()) ||
     c.symbol.toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="wl-card">
      <div className="wl-header">
        <h3 className="wl-title">{t("watchlist.title")}</h3>
        <span className="wl-subtitle">
          {t("watchlist.updated")} ·{" "}
          <span className="wl-source-badge">Binance</span>
        </span>
        <div className="wl-search-wrap" ref={searchRef}>
          <button className="wl-add-btn" onClick={() => setSearchOpen(v => !v)}>
            {t("watchlist.addCoin")}
          </button>
          {searchOpen && (
            <div className="wl-dropdown">
              <input
                className="wl-search-input"
                placeholder={t("watchlist.searchPlaceholder")}
                value={search}
                onChange={e => setSearch(e.target.value)}
                autoFocus
              />
              <div className="wl-dropdown-list">
                {filteredCatalog.slice(0, 20).map(c => (
                  <button key={c.id} className="wl-dropdown-item" onClick={() => addCoin(c.id)}>
                    <span className="wl-dropdown-sym">{c.symbol}</span>
                    <span className="wl-dropdown-name">{c.name}</span>
                  </button>
                ))}
                {filteredCatalog.length === 0 && (
                  <div className="wl-dropdown-empty">{t("watchlist.noResults")}</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {loading && watchedIds.length > 0 && (
        <div className="wl-loading">{t("watchlist.loading")}</div>
      )}

      {!loading && watchedIds.length === 0 && (
        <div className="wl-empty">
          <div className="wl-empty-icon">☆</div>
          <div className="wl-empty-text">{t("watchlist.emptyText")}</div>
          <div className="wl-empty-hint">{t("watchlist.emptyHint")}</div>
        </div>
      )}

      {!loading && watchedIds.length > 0 && (
        <div className="wl-list">
          {watchedIds.map(id => {
            const meta   = CATALOG.find(c => c.id === id);
            const symbol = (meta?.symbol ?? "").toUpperCase();
            const entry  = priceData.get(symbol);
            const spark  = sparklines.get(symbol) ?? [];
            const pct    = entry?.pct ?? 0;
            const up     = pct >= 0;
            return (
              <div key={id} className="wl-row">
                <div className="wl-row-icon">
                  {!imgErrors.has(symbol) ? (
                    <img
                      className="wl-coin-img"
                      src={`https://assets.coincap.io/assets/icons/${symbol.toLowerCase()}@2x.png`}
                      alt={symbol}
                      loading="lazy"
                      onError={() => setImgErrors(prev => new Set([...prev, symbol]))}
                    />
                  ) : (
                    <div className="wl-coin-placeholder">{symbol[0] ?? "?"}</div>
                  )}
                </div>

                <div className="wl-row-info">
                  <span className="wl-row-symbol">{symbol}-USD</span>
                  <span className="wl-row-vol">{t("watchlist.vol")} {entry ? fmtVol(entry.vol) : "—"}</span>
                </div>

                {spark.length > 1 && (
                  <div className="wl-row-spark">
                    <Sparkline prices={spark} positive={up} />
                  </div>
                )}

                <div className="wl-row-right">
                  <span className="wl-row-price">${entry ? fmtPrice(entry.price) : "—"}</span>
                  <span className={`wl-row-pct${up ? " up" : " down"}`}>
                    {up ? "↗" : "↘"} {Math.abs(pct).toFixed(2)}%
                  </span>
                </div>

                <button
                  className="wl-row-star"
                  onClick={() => removeCoin(id)}
                  title={t("watchlist.removeTitle")}
                >
                  ★
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
