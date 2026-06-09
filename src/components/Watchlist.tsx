import { useEffect, useRef, useState } from "react";
import "../styles/Watchlist.css";

interface CatalogEntry { id: string; symbol: string; name: string }

interface CoinMarket {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  price_change_percentage_24h: number;
  market_cap: number;
  total_volume: number;
  sparkline_in_7d: { price: number[] };
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
  const sample = prices.filter((_, i) => i % 4 === 0);
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
  const [watchedIds, setWatchedIds] = useState<string[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("watchlistCoins_v1") ?? "null");
      return Array.isArray(saved) && saved.length > 0 ? saved : DEFAULT_IDS;
    } catch { return DEFAULT_IDS; }
  });
  const [coinData, setCoinData] = useState<Map<string, CoinMarket>>(new Map());
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem("watchlistCoins_v1", JSON.stringify(watchedIds));
  }, [watchedIds]);

  useEffect(() => {
    if (watchedIds.length === 0) { setLoading(false); return; }

    async function fetchData() {
      try {
        const ids = watchedIds.join(",");
        const res = await fetch(
          `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&sparkline=true&price_change_percentage=24h&order=market_cap_desc`
        );
        if (!res.ok) return;
        const data: CoinMarket[] = await res.json();
        setCoinData(new Map(data.map(c => [c.id, c])));
        setLoading(false);
      } catch { /* silently fail */ }
    }

    fetchData();
    const id = setInterval(fetchData, 60_000);
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
        <h3 className="wl-title">Watchlist</h3>
        <span className="wl-subtitle">
          Updated every minute ·{" "}
          <a className="wl-source-badge" href="https://www.coingecko.com" target="_blank" rel="noopener noreferrer">
            Powered by CoinGecko
          </a>
        </span>
        <div className="wl-search-wrap" ref={searchRef}>
          <button className="wl-add-btn" onClick={() => setSearchOpen(v => !v)}>
            + Add Coin
          </button>
          {searchOpen && (
            <div className="wl-dropdown">
              <input
                className="wl-search-input"
                placeholder="Search by name or symbol…"
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
                  <div className="wl-dropdown-empty">No results</div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {loading && watchedIds.length > 0 && (
        <div className="wl-loading">Loading market data…</div>
      )}

      {!loading && watchedIds.length === 0 && (
        <div className="wl-empty">
          <div className="wl-empty-icon">☆</div>
          <div className="wl-empty-text">No coins in your watchlist</div>
          <div className="wl-empty-hint">Click "+ Add Coin" to start tracking</div>
        </div>
      )}

      {!loading && watchedIds.length > 0 && (
        <div className="wl-list">
          {watchedIds.map(id => {
            const coin = coinData.get(id);
            const meta = CATALOG.find(c => c.id === id);
            const pct = coin?.price_change_percentage_24h ?? 0;
            const up = pct >= 0;
            const symbol = (coin?.symbol ?? meta?.symbol ?? "").toUpperCase();
            return (
              <div key={id} className="wl-row">
                <div className="wl-row-icon">
                  {coin?.image
                    ? <img className="wl-coin-img" src={coin.image} alt={symbol} loading="lazy" />
                    : <div className="wl-coin-placeholder">{symbol[0] ?? "?"}</div>
                  }
                </div>

                <div className="wl-row-info">
                  <span className="wl-row-symbol">{symbol}-USD</span>
                  <span className="wl-row-vol">Vol {coin ? fmtVol(coin.total_volume) : "—"}</span>
                </div>

                {coin?.sparkline_in_7d?.price && (
                  <div className="wl-row-spark">
                    <Sparkline prices={coin.sparkline_in_7d.price} positive={up} />
                  </div>
                )}

                <div className="wl-row-right">
                  <span className="wl-row-price">${coin ? fmtPrice(coin.current_price) : "—"}</span>
                  <span className={`wl-row-pct${up ? " up" : " down"}`}>
                    {up ? "↗" : "↘"} {Math.abs(pct).toFixed(2)}%
                  </span>
                </div>

                <button
                  className="wl-row-star"
                  onClick={() => removeCoin(id)}
                  title="Remove from watchlist"
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
