/**
 /*
 * ────────────────────────────────────────────────────────────────────────────────
 * Event-Driven Uniswap V3 Execution Bot (MEV-Style Route Engine)
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * Overview:
 * - Monitors live Uniswap V3 Swap events across selected WETH-based pools
 * - Uses a curated token universe to build a full pool registry:
 *   tokenA_tokenB → multiple fee-tier pools (500 / 3000 / 10000)
 * - Reacts to swap events by analyzing local liquidity topology around WETH
 * - Builds a dynamic token graph from the pool registry
 * - Finds optimal execution paths using multi-hop route simulation
 * - Selects best-performing route across:
 *     • direct single-hop swaps
 *     • multi-hop circular routes (graph-based arbitrage loops)
 *
 * Architecture:
 * - Pool Registry (authoritative source of all token pair liquidity + fee tiers)
 * - Graph Builder (derived topology from registry, used for path discovery)
 * - Edge Resolver (selects best pool per token pair using quoter simulation)
 * - Path Simulator (evaluates full routes using sequential swap simulation)
 * - Profit Engine (compares direct vs multi-hop opportunities)
 * - Execution Layer (flash-loan based trade execution using enriched routes)
 *
 * Strategy Type:
 * - Single-DEX MEV execution (Uniswap V3)
 * - Latency-sensitive reaction system (event-driven, not mempool scanning)
 * - WETH-centric anchor trading model
 * - Hybrid strategy:
 *     ✔ direct edge exploitation (single pool inefficiencies)
 *     ✔ graph arbitrage (multi-token cyclic routing)
 *
 * Key Features:
 * - BigInt-based math for all execution, routing, and profit calculations
 * - Ethers v6 compatible architecture
 * - Multi-fee-tier pool awareness per token pair
 * - Dynamic best-pool selection via quoter-based evaluation
 * - Edge caching for route simulation efficiency
 * - Duplicate transaction protection and execution locks
 *
 * Routing Logic:
 * - Build token graph from poolRegistry connections
 * - Generate valid cyclic and multi-hop paths from WETH anchor
 * - Simulate each path using best available pool per edge
 * - Compare all results and select highest profit route
 * - Enrich final route with execution-ready hop instructions:
 *     { tokenIn, tokenOut, pool, fee }
 *
 * Execution Flow:
 * 1. Swap event detected
 * 2. Local pool registry lookup for affected token pair
 * 3. Graph expansion from WETH neighborhood
 * 4. Path generation (cycle detection up to max hop depth)
 * 5. Edge-by-edge simulation using best available pools
 * 6. Compare direct vs multi-hop profit outcomes
 * 7. Build execution-grade routePlan (fully resolved swaps)
 * 8. Execute via flash-loan contract if profitable
 *
 * Notes:
 * - This system no longer assumes a single best pool per pair
 * - Execution depends on dynamically selected pool per hop
 * - Path output is no longer just token arrays but execution-ready routes
 * - System prioritizes route correctness over theoretical price discovery
 *
 * Important Distinction:
 *
 * ✔ multi-path routing + dynamic pool selection + execution-grade simulation
 *
 * NOT:
 *
 * ❌ static fee-tier switching on a single pair
 * ❌ naive two-hop arbitrage only
 * ❌ price-only comparison without route construction
 */

require("./helpers/server");
require("dotenv").config();

const { ethers } = require("ethers");
const chalk = require("chalk");
const config = require("./config.json");

// Now destructure after the config is loaded
const { PROJECT_SETTINGS } = config;

const {getFlashLoanSize, generateLoanSizes, validatePool, checkPoolTradeability, formatCompactBigInt, minSpread} = require("./helpers/helpers");
const initialization = require("./helpers/initialization");

const topTokens = require("./helpers/topTokens");
const REQUIRE_MEMPOOL_MATCH = true;
let lastMempoolEvent = Date.now();
let isResetting = false;

// Simulate orange color
const orange = chalk.rgb(255, 140, 0);
const RESET = "\x1b[0m";
const ORANGE = "\x1b[38;5;208m";

// ENV
const arbFor = process.env.ARB_FOR;       // e.g., WETH
const wethAddress = process.env.WETH;
const vaultAddress = process.env.VAULT_ADDRESS || ethers.ZeroAddress;

// Minimal ERC20 ABI
const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// ─────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────
async function main() {
  const isLocal = PROJECT_SETTINGS.isLocal;
  const networkType = isLocal ? "LOCAL" : "ARBITRUM";

  const { ethers } = require("ethers");

  const executionProvider = new ethers.JsonRpcProvider(
    isLocal
      ? (process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545")
      : `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
  );

  const monitoringProvider = isLocal
    ? executionProvider: new ethers.WebSocketProvider(
        `wss://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
      );

  process.on("SIGINT", () => { console.log("\n\n🛑 Shutting down monitor..."); monitoringProvider.destroy(); process.exit(0); });

  async function processSwapQueue(ctx) {

      const refs = ctx.refs;

      if (refs._isProcessingSwapQueue)
          return;

      refs._isProcessingSwapQueue = true;

      try {

          while (refs._swapQueue) {
              // grab current event
              const params = refs._swapQueue;

              // clear slot immediately
              refs._swapQueue = null;

              await swapEvent(ctx, params);
              // if another event arrived while swapEvent ran,  loop once more and process only the newest one
          }

      } catch (e) {
          console.log("❌ swap queue error:", e.message);

      } finally {
          refs._isProcessingSwapQueue = false;

      }
  }

  initialization.initContracts(executionProvider);
  await initialization.init();

  monitoringProvider.on("error", e => {
    console.log("Websocket error:", e.message);
  });

  const signer = new ethers.Wallet(
    process.env.PRIVATE_KEY,
    executionProvider
  );

  const attachedPools = new Set();
  const startBlock = await executionProvider.getBlockNumber();

  let monitoringPaused = false;
  let dots = 0;
  const seenEvents = new Map();

  const startMonitoring = () => {
    setInterval(() => {
      if (!monitoringPaused) {
        dots = (dots + 1) % 7;
        process.stdout.write(`\r⏳ Monitoring${".".repeat(dots)}   `);
      }
    },500);
  };

  const readline = require("readline");
  const pauseMonitoring = () => {
    monitoringPaused = true;

    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
  };

  const resumeMonitoring = () => monitoringPaused = false;
  const addr = a => a.toLowerCase();

  const WETH = addr(process.env.WETH);
  const USDC = addr(process.env.USDC);
  const BASE_ASSETS = new Set(topTokens.map(t => addr(t.address)));
  const V3_FEES = [100,500,3000,10000];

  const makePairKey = (a,b) => [addr(a),addr(b)].sort().join("_");

  globalThis.makePairKey = makePairKey;

  // fresh registry
  const poolRegistry = new Map();
  globalThis.poolRegistry = poolRegistry;

  const getPool = async (a, b, fee) => {
    try {
      const pool = await initialization.uniV3Factory.getPool(a, b, fee);
      if (!pool || pool === ethers.ZeroAddress) return null;

      return pool.toLowerCase();
    } catch {
      return null;
    }
  };

  const registerPoolsForPair = async (tokenA, tokenB) => {
    const norm = (a) => a.toLowerCase();

    const a = norm(tokenA.address);
    const b = norm(tokenB.address);

    //if(a !== WETH && b !== WETH) return;
    if (!BASE_ASSETS.has(a) && !BASE_ASSETS.has(b)) {return;}

    // ✅ canonical key (always sorted)
    const key = makePairKey(a, b);

    const pools = [];

    for (const fee of V3_FEES) {
      try {
        // IMPORTANT: always pass normalized addresses
        const pool = await getPool(tokenA.address, tokenB.address, fee);

        if (!pool) continue;
        const info = await validatePool(pool, executionProvider);

        if(!info)
          continue;

        pools.push({
          address:pool.toLowerCase(),
          fee,
          liquidity:info.liquidity,
          sqrtPriceX96:info.sqrtPriceX96
        });

      } catch (e) {
        // silent fail is fine for discovery phase
        continue;
      }
    }

    if (pools.length === 0) return;

      poolRegistry.set(key, {tokenA: a, tokenB: b, pools});
    };

  let loadedTokens=0;

  for (const token of topTokens) {
    try {
      const tokenAddr = addr(token.address);

      const code = await executionProvider.getCode(tokenAddr);
      if (code === "0x") continue;

      const contract = new ethers.Contract(tokenAddr, ERC20_ABI, executionProvider);

      // decimals (safe fallback)
      let decimals = 18;
      try {
        decimals = Number(await contract.decimals());
      } catch {}

      // symbol (optional)
      let symbol;
      try {
        symbol = await contract.symbol();
      } catch {}

      // apply normalized / finalized token object
      token.address = tokenAddr;
      token.contract = contract;
      token.decimals = decimals;
      token.symbol = symbol;

      loadedTokens++;

    } catch {
      // ignore bad tokens entirely
      continue;
    }
  }

  console.log(`✅ Loading ${loadedTokens} tokens`);

  if (!topTokens.some(t => t.address === WETH)) throw new Error("WETH missing");

  const ctx = {

    isLocal,
    networkType,

    executionProvider,
    monitoringProvider,

    signer,
    getFlashLoanSize,

    refs:{
      _swapQueue: null,
      _isProcessingSwapQueue:false,
      processingEvent:false,
      goodTradesCounter:0,
      lastSubmittedTxHash:null,
      isGlobalExecuting:false
    },

    addr,

    analyze,
    checkProfit,
    executeTrade,
    minProfit: ethers.parseUnits("0.01", 18),

    poolRegistry,
    makePairKey,

    arbitrageContract: initialization.arbitrage,
    topTokens,

    quoter: initialization.uniV3Quoter,
    factory: initialization.uniV3Factory,

    ui:{
      pauseMonitoring,
      resumeMonitoring
    }
  };

  async function loadInitialPools(){
    const pairs=[];

    for(let i=0;i<topTokens.length;i++){
      for(let j=i+1;j<topTokens.length;j++){

        if(topTokens[i].address===topTokens[j].address)
          continue;

        pairs.push([topTokens[i],topTokens[j]]);
      }
    }

    let found=0;
    for(const [a,b] of pairs){
      const before=poolRegistry.size;
      await registerPoolsForPair(a,b);

      if(poolRegistry.size>before)
        found++;
    }

    let totalPools=0;
    for(const [,v] of poolRegistry){
      totalPools += v.pools.length;
    }

    console.log(`
  ──────── POOL REGISTRY ────────
  Pairs checked : ${pairs.length}
  Pairs found   : ${found}
  Pools tracked : ${totalPools}
  ───────────────────────────────
  `);
  }
  await loadInitialPools();

  const IUniswapV3Pool =require("@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json");
  const poolInterface = new ethers.Interface(IUniswapV3Pool.abi);

  const poolAddresses = [];

  for (const entry of poolRegistry.values()) {
      for (const p of entry.pools) {
          poolAddresses.push(p.address);
      }
  }

  const SWAP_TOPIC = ethers.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
  const filter = {address: poolAddresses, topics: [SWAP_TOPIC]};

  monitoringProvider.on(filter, async (log) => {

    const txHash = log.transactionHash;
    const logIndex = log.index;

    if (txHash == null || logIndex == null)
        return;

    const eventKey = `${txHash}-${logIndex}`;

    if (seenEvents.has(eventKey))
        return;

    seenEvents.set(eventKey, Date.now());
    const parsed = poolInterface.parseLog(log);

    if (!parsed)
        return;

    const event = {...log, args: parsed.args, fragment: parsed.fragment, name: parsed.name, signature: parsed.signature};
    ctx.refs._swapQueue = {event, startBlock};

    processSwapQueue(ctx);
  });
  console.log(`👀 Watching ${poolAddresses.length} pools`);
  startMonitoring();
}

// ──────────────────────────────────────
// SWAP EVENT (REFACTORED PROPERLY)
// ─────────────────────────────────────────
async function swapEvent(ctx, params) {
  const { event, startBlock } = params;

  const { 
      refs, 
      analyze, 
      checkProfit, 
      executeTrade, 
      ui 
  } = ctx;

  const poolRegistry = ctx.poolRegistry;

  const { pauseMonitoring, resumeMonitoring } = ui || {};


  // ============================================================
  // EXECUTION LOCK
  // ============================================================

  if (refs.isGlobalExecuting) {
      console.log("⏳ Swap already processing, ignoring event");
      return;
  }

  refs.isGlobalExecuting = true;


  try {


      // ============================================================
      // VALIDATE POOL REGISTRY
      // ============================================================

      if (!(poolRegistry instanceof Map)) {
          console.error("❌ poolRegistry invalid at swapEvent level");
          console.log(poolRegistry);
          return;
      }


      // ============================================================
      // EVENT VALIDATION
      // ============================================================

      const log = event?.log ?? event;
      if (!log) return;

      const { transactionHash: txHash, blockNumber, address } = log;

      if (!txHash || !blockNumber || !address) return;


      if (
          refs.lastSubmittedTxHash &&
          txHash.toLowerCase() === refs.lastSubmittedTxHash
      ) {
          return;
      }


      // ============================================================
      // INIT STATE
      // ============================================================

      refs._seenTx ??= new Set();

      if (refs._seenTx.has(txHash)) return;
      refs._seenTx.add(txHash);


      if (address === "0xE592427A0AEce92De3Edee1F18E0157C05861564") {
          return;
      }


      // ============================================================
      // ANALYZE
      // ============================================================

      pauseMonitoring?.();

      let analysis;

      try { analysis = await analyze(ctx, {event: log, startBlock, refs}); } catch(e) { console.log("❌ analyze error:", e.message); return; }

      if (!analysis?.pass || !analysis?.tradeCandidate) return;


      // ============================================================
      // CHECK PROFIT
      // ============================================================

      let profit;
      try { profit = await checkProfit(ctx, {tradeCandidate: analysis.tradeCandidate, eventBlock: event.blockNumber}); }
      catch (e) { console.log("❌ checkProfit failed:", e.message); return; }

      if (!profit?.profitable) return;

      // ============================================================
      // EXECUTE TRADE
      // ============================================================

      try {

          await executeTrade(ctx, {
              tokenIn: profit.tokenIn,
              flashAmount: profit.flashAmount,
              executionRoute: profit.executionRoute,
              netProfit: profit.netProfit,
              flashToken: profit.flashToken,
              expectedUsdc: profit.expectedUsdc
          });

      } catch (err) {
          console.error("❌ executeTrade failed:", err.message);
      }

  } finally {

      resumeMonitoring?.();
      refs.isGlobalExecuting = false;
  }
}

// ─────────────────────────────────────────────
// Analyze will be a hard gate based on the Event Seen
// ─────────────────────────────────────────────
async function analyze(ctx, params) {
  
  // =====================================================
  // 1. Context & Event Validation
  // =====================================================

  const {event, startBlock} = params;

  const {
      addr,
      executionProvider: provider,
      quoter,
      factory,
      signer,
      arbitrageContract,
      minProfit,
      topTokens,
      tokenRegistry,
      poolRegistry,
      refs
  } = ctx;

  const POOL_ABI=[
  "function token0() view returns(address)", "function token1() view returns(address)", "function fee() view returns(uint24)",
  "function liquidity() view returns(uint128)", "function slot0() view returns(uint160 sqrtPriceX96,int24 tick,uint16,uint16,uint16,uint8,bool)"
  ];

  const COL = {rank: 6, fee: 9, liquidity: 25, quality: 20, test: 15, price: 16, spread: 11, event: 7};
  const stripAnsi = (str) => String(str).replace(/\x1B\[[0-9;]*m/g, "");

  const col = (value, width) => {
    const text = String(value);
    const visibleLength = stripAnsi(text).length;

    return text + " ".repeat(Math.max(0, width - visibleLength));
  };

  // =====================================================
  // Math Constants
  // =====================================================

  const SCALE = 10n ** 18n;
  const Q192 = 2n ** 192n;
  const REQUIRED_GROSS_SPREAD = 0.05;
  const MIN_ROUND_TRIP_PROFIT = 0.00;

  const registry = poolRegistry;

  if (!registry) { console.log("❌ poolRegistry missing"); return { pass: false }; }

  const log = event?.log || event;
  if (!log) return { pass: false };

  const { blockNumber: eventBlock, args } = log;

  if (!eventBlock || eventBlock <= startBlock) return { pass: false };
  if (!args) return { pass: false };

  const amount0 = BigInt(args[2]);
  const amount1 = BigInt(args[3]);

  const poolAddress = log.address.toLowerCase();
  const norm = address => address.toLowerCase();

  // =====================================================
  // 2. Load Event Pool Information
  // =====================================================

  let token0, token1, fee;
  let bestTrade = null;
  let totalRoutesChecked = 0;

  try {
    const pool = new ethers.Contract(poolAddress, POOL_ABI, provider);

    [token0, token1, fee] = await Promise.all([
      pool.token0({ blockTag: eventBlock }),
      pool.token1({ blockTag: eventBlock }),
      pool.fee({ blockTag: eventBlock })
    ]);
  } catch (e) {
    console.log("SECTION 2 ERROR", { poolAddress, eventBlock, error: e.message });
    return { pass: false };
  }

  token0 = norm(token0);
  token1 = norm(token1);
  fee = Number(fee);

  const t0 = topTokens.find(t => norm(t.address) === token0);
  const t1 = topTokens.find(t => norm(t.address) === token1);

  if (!t0 || !t1) {
    console.log("SECTION 2 TOKEN FAIL", { token0, token1 });
    return { pass: false };
  }

  // =====================================================
  // 3. Resolve Trade Direction
  // =====================================================

  let inputToken, outputToken, amountIn;

  if (amount0 > 0n) {
    inputToken = t0;
    outputToken = t1;
    amountIn = amount0;
  } else if (amount1 > 0n) {
    inputToken = t1;
    outputToken = t0;
    amountIn = amount1;
  } else {
    return { pass: false };
  }

  const WETH = "0x82af49447d8a07e3bd95bd0d56f35241523fbab1";
  const isWeth = inputToken.address.toLowerCase() === WETH || outputToken.address.toLowerCase() === WETH;

  if (!isWeth) return { pass: false };

  const canonicalKey = makePairKey(token0, token1);
  const entry = registry.get(canonicalKey);
  const registryPools = Array.isArray(entry) ? entry : Array.isArray(entry?.pools) ? entry.pools : [];
  const uniquePools = registryPools.length ? [...registryPools] : [];

  if (!uniquePools.length) return { pass: false };


  // =====================================================
  // 4. SWAP EVENT 
  // =====================================================

  const latestBlock = await provider.getBlockNumber();
  const amountOut = amount0 > 0n ? -amount1 : -amount0;
  const direction = `${inputToken.symbol} → ${outputToken.symbol}`;
  const action = outputToken.address.toLowerCase() === WETH ? `BUY ${outputToken.symbol}` : `SELL ${inputToken.symbol}`;

  const border = () => console.log(orange("═══════════════════════════════════════════════════════════"));
  const shortAddress = addr => `${addr.slice(0,6)}...${addr.slice(-4)}`;
  const pairName = `${inputToken.symbol}/${outputToken.symbol}`;

  border();
  console.log("🔔 SWAP EVENT DETECTED");
  border();

  console.log(`Pair                : ${pairName}`);
  console.log(`Direction           : ${direction}`);
  console.log(`Action              : ${action}`);
  console.log(`Bought              : ${ethers.formatUnits(amountOut, outputToken.decimals)} ${outputToken.symbol}`);
  console.log(`Sold                : ${ethers.formatUnits(amountIn, inputToken.decimals)} ${inputToken.symbol}`);
  console.log(`Pool                : ${shortAddress(poolAddress)}`);
  console.log(`Block               : ${eventBlock}`);
  console.log("");

  // =====================================================
  // 5. Build Pool Snapshot
  // =====================================================

  const enrichedPools = [];

  for (const p of uniquePools) {
    try {
      const c = new ethers.Contract(p.address, POOL_ABI, provider);
      const [poolToken0, poolToken1, poolFee, liquidity] = await Promise.all([
        c.token0({ blockTag: eventBlock }),
        c.token1({ blockTag: eventBlock }),
        c.fee({ blockTag: eventBlock }),
        c.liquidity({ blockTag: eventBlock })
      ]);

      const poolLiquidity = BigInt(liquidity);
      if (poolLiquidity === 0n) continue;

      const token0 = norm(poolToken0);
      const token1 = norm(poolToken1);
      const poolT0 = topTokens.find(t => norm(t.address) === token0);
      const poolT1 = topTokens.find(t => norm(t.address) === token1);

      if (!poolT0 || !poolT1) continue;

      const wethIsToken0 = token0 === WETH.toLowerCase();
      const tradeTokenAddress = wethIsToken0 ? token1 : token0;
      const poolForQuote = { ...p, address: p.address, fee: Number(poolFee), liquidity: poolLiquidity };

      const tradeability = await checkPoolTradeability(
        poolForQuote,
        WETH,
        tradeTokenAddress,
        quoter,
        factory,
        eventBlock
      );

      enrichedPools.push({
        ...p,
        address: p.address,
        fee: Number(poolFee),
        liquidity: poolLiquidity,
        token0,
        token1,
        token0Symbol: poolT0.symbol,
        token1Symbol: poolT1.symbol,
        tradeable: tradeability.usable === true,
        tradeability,
        wethIsToken0,
        tradeToken: tradeTokenAddress
      });

    } catch (e) {
      console.log(`❌ Pool ${p.address} error: ${e.shortMessage || e.reason || e.message}`);
    }
  }

  // =====================================================
  // 6. Rank Pools
  // =====================================================

  // -----------------------------------------------------
  // 6.1 Tradeability
  // -----------------------------------------------------

  for (const p of enrichedPools) p.tradeable = p.tradeability?.usable === true;

  // -----------------------------------------------------
  // 6.2 Depth / Executable Quote Filter
  // -----------------------------------------------------

  const MIN_DEPTH_RATIO = 80n;

  const quotedPools = enrichedPools.filter(p => p.tradeable && (p.tradeability?.testAmountOut ?? 0n) > 0n && (p.tradeability?.wethReturned ?? 0n) > 0n);
  const bestDepthOut = quotedPools.reduce((best, p) => p.tradeability.testAmountOut > best ? p.tradeability.testAmountOut : best, 0n);

  for (const p of enrichedPools) {
    const quoteOut = p.tradeability?.testAmountOut ?? 0n;
    const wethReturned = p.tradeability?.wethReturned ?? 0n;

    p.depthRatio = bestDepthOut > 0n ? Number((quoteOut * 10000n) / bestDepthOut) / 100 : 0;

    p.depthPassed =
      p.tradeable &&
      quoteOut > 0n &&
      wethReturned > 0n &&
      bestDepthOut > 0n &&
      quoteOut * 100n >= bestDepthOut * MIN_DEPTH_RATIO;

    if (!p.depthPassed) {
      p.tradeable = false;

      if (p.tradeability) {
        p.tradeability.reason =
          quoteOut === 0n
            ? "no executable quote"
            : wethReturned === 0n
              ? "reverse quote failed"
              : `insufficient depth (${p.depthRatio.toFixed(2)}% of best)`;
      }
    }
  }

  // -----------------------------------------------------
  // 6.3 Event Pool
  // -----------------------------------------------------

  const eventPool = enrichedPools.find(p => p.address.toLowerCase() === poolAddress);
  if (!eventPool) return { pass: false };

  // -----------------------------------------------------
  // 6.4 Reference Quote
  // -----------------------------------------------------

  const referencePrice = eventPool.tradeability?.testAmountOut ?? 0n;
  if (referencePrice <= 0n) return { pass: false };

  // -----------------------------------------------------
  // 6.5 Liquidity Ranking
  // -----------------------------------------------------

  const maxLiquidity = enrichedPools.reduce((max, p) => p.liquidity > max ? p.liquidity : max, 0n);
  if (maxLiquidity === 0n) return { pass: false };

  for (const [i, p] of enrichedPools.entries()) {
    p.rank = i + 1;
    p.liquidityPercent = Number((p.liquidity * 100000n) / maxLiquidity) / 1000;
    p.qualityLevel = p.tradeable ? "usable" : "unusable";
    p.qualityIcon = p.tradeable ? "\x1b[32m🟢\x1b[0m" : "\x1b[31m🔴\x1b[0m";
    p.qualityText = p.tradeable ? "Usable" : "Unusable";
  }

  // -----------------------------------------------------
  // 6.6 Pool Ranking Display
  // -----------------------------------------------------

  border();
  console.log("📊 POOL RANKING");
  border();

  console.log(`Event Block         : ${eventBlock}`);
  console.log(`Pair                : ${pairName}`);
  console.log("");

  console.log(
    col("Rank", COL.rank) +
    col("Fee", COL.fee) +
    col("Liquidity", COL.liquidity) +
    col("Quality", COL.quality) +
    col("Price", COL.price) +
    col("Spread", COL.spread) +
    col("Event", COL.event)
  );

  for (const p of enrichedPools) {
    const eventMark = p.address.toLowerCase() === poolAddress ? "★" : "";
    const quote = p.tradeability?.testAmountOut ?? 0n;
    const decimals = p.tradeability?.tradeDecimals ?? 18;
    const displayPrice = Number(ethers.formatUnits(quote, decimals));
    const priceDiff = referencePrice > 0n ? Number(((quote - referencePrice) * 10000n) / referencePrice) / 100 : 0;
    const liquidityPct = p.liquidityPercent >= 1 ? p.liquidityPercent.toFixed(2) : p.liquidityPercent < 0.01 ? "<0.01" : p.liquidityPercent.toFixed(2);

    console.log(
      col(p.rank, COL.rank) +
      col(`${(p.fee / 10000).toFixed(2)}%`, COL.fee) +
      col(`${formatCompactBigInt(p.liquidity)} (${liquidityPct}%)`, COL.liquidity) +
      col(`${p.qualityIcon} ${p.qualityText}`, COL.quality) +
      col(displayPrice.toFixed(8), COL.price) +
      col(`${priceDiff >= 0 ? "+" : ""}${priceDiff.toFixed(2)}%`, COL.spread) +
      col(eventMark, COL.event)
    );
  }

  console.log("");

  // =====================================================
  // POOL DEPTH / TRADEABILITY CHECK
  // =====================================================

  border();
  console.log("💧 POOL DEPTH TEST");
  border();

  console.log(`Event Block         : ${eventBlock}`);
  console.log("");

  const DEPTH_TEST_AMOUNT = ethers.parseUnits("0.03", 18);

  console.log(`Test Amount: ${ethers.formatUnits(DEPTH_TEST_AMOUNT, 18)} WETH`);

  for (const pool of enrichedPools) {
      const depth = pool.tradeability;
      const amountIn = depth?.testAmountIn ?? DEPTH_TEST_AMOUNT;
      const amountOut = depth?.testAmountOut ?? 0n;
      const outputSymbol = pool.token0.toLowerCase() === WETH.toLowerCase() ? pool.token1Symbol : pool.token0Symbol;
      const decimals = depth?.tradeDecimals ?? 18;
      const fee = (Number(pool.fee) / 10000).toFixed(2);
      const usable = pool.tradeable && amountOut > 0n;

      console.log(`Pool ${fee}%`);
      console.log(
          usable
              ? `  ${ethers.formatUnits(amountIn, 18)} WETH → ${ethers.formatUnits(amountOut, decimals)} ${outputSymbol}  🟢 Usable`
              : `  ${ethers.formatUnits(amountIn, 18)} WETH → QUOTE FAILED  🔴 Unusable`
      );
      console.log("");
  }

  // =====================================================
  // TRADE STATUS
  // =====================================================

  const executablePools = enrichedPools.filter(p => p.tradeable);
  const validPools = executablePools.filter(p => (p.tradeability?.testAmountOut ?? 0n) > 0n && (p.tradeability?.wethReturned ?? 0n) > 0n);
  const validPoolsPassed = validPools.length >= 2;

  console.log("Trade Status:");
  console.log(`  Event Block        : ${eventBlock}`);
  console.log(`  💧 Candidate Pools : ${validPoolsPassed ? "✅ Passed" : "❌ Failed"} (${validPools.length}/2 required pools)`);

  if (!validPoolsPassed) return { pass: false };

  // =====================================================
  // EXECUTABLE ROUND-TRIP QUOTE
  // =====================================================

  const testAmount = ethers.parseUnits("0.03", 18);
  if (testAmount <= 0n) return { pass: false };

  let bestRoute = null;

  for (let i = 0; i < validPools.length; i++) {
      for (let j = 0; j < validPools.length; j++) {
          if (i === j) continue;

          const buyPool = validPools[i];
          const sellPool = validPools[j];

          try {
              const tokenAmount = BigInt(
                  (
                      await quoter.quoteExactInputSingle.staticCall(
                          WETH,
                          buyPool.tradeToken,
                          Number(buyPool.fee),
                          testAmount,
                          0n,
                          { blockTag: eventBlock }
                      )
                  ).toString()
              );

              if (tokenAmount <= 0n) continue;

              const wethReturned = BigInt(
                  (
                      await quoter.quoteExactInputSingle.staticCall(
                          sellPool.tradeToken,
                          WETH,
                          Number(sellPool.fee),
                          tokenAmount,
                          0n,
                          { blockTag: eventBlock }
                      )
                  ).toString()
              );

              if (wethReturned <= 0n) continue;

              const profit = wethReturned - testAmount;

              if (!bestRoute || profit > bestRoute.difference) {
                  bestRoute = {
                      buyPool,
                      sellPool,
                      amountIn: testAmount,
                      amountOut: tokenAmount,
                      amountReturned: wethReturned,
                      difference: profit
                  };
              }

          } catch (e) {
              // Ignore failed routes; continue checking remaining pairs.
          }
      }
  }

  if (!bestRoute) return { pass: false };

  // =====================================================
  // BEST ROUTE DISPLAY
  // =====================================================

  const spreadPercent = Number(bestRoute.difference) / Number(bestRoute.amountIn) * 100;
  const tokenDecimals = bestRoute.buyPool.tradeability?.tradeDecimals ?? 18;

  console.log(
      `  🔎 Best Route: ${(bestRoute.buyPool.fee / 10000).toFixed(2)}% → ${(bestRoute.sellPool.fee / 10000).toFixed(2)}%` +
      ` | ${ethers.formatUnits(bestRoute.amountIn, 18)} WETH` +
      ` → ${ethers.formatUnits(bestRoute.amountOut, tokenDecimals)}` +
      ` → ${ethers.formatUnits(bestRoute.amountReturned, 18)} WETH` +
      ` | ${spreadPercent >= 0 ? "+" : ""}${spreadPercent.toFixed(6)}%`
  );

  // =====================================================
  // EXECUTABLE ROUND-TRIP DIFFERENCE
  // =====================================================

  const roundTripDifference = Number(bestRoute.difference) / Number(bestRoute.amountIn) * 100;
  const executablePassed = bestRoute && bestRoute.difference > 0n;

  // =====================================================
  // STORE BEST TRADE CANDIDATE
  // =====================================================

  bestTrade = {
    buyPool: bestRoute.buyPool,
    sellPool: bestRoute.sellPool,
    spread: roundTripDifference * 1e16,
    spreadPercent: roundTripDifference,
    requiredSpread: REQUIRED_GROSS_SPREAD,
    testAmountIn: bestRoute.amountIn,
    testAmountOut: bestRoute.amountOut,
    wethReturned: bestRoute.amountReturned
  };

  if (executablePassed) {
    totalRoutesChecked++;
  }

  // =====================================================
  // PRE-CHECK RESULT
  // =====================================================

  const spreadPassed = bestTrade !== null && bestTrade.spreadPercent >= REQUIRED_GROSS_SPREAD;
  const spreadStatus = spreadPassed ? "✅ Passed" : "❌ Failed";
  const poolFeePercent = bestTrade ? (Number(bestTrade.buyPool.fee) + Number(bestTrade.sellPool.fee)) / 10000 : 0;

  console.log(`  📈 Round Trip Gross Spread     : ${spreadStatus} (${bestTrade ? `${bestTrade.spreadPercent >= 0 ? "+" : ""}${bestTrade.spreadPercent.toFixed(6)}%` : "0.000000%"} / +${REQUIRED_GROSS_SPREAD.toFixed(2)}%)`);
  console.log(`  💸 Pool Fees                   : ${poolFeePercent.toFixed(2)}%`);

  // =====================================================
  // PRE-CHECK DECISION
  // =====================================================

  if (!validPoolsPassed || !spreadPassed) return { pass: false };

  console.log("  🔎 Executable quote pre-checks passed - analyzing routes");

  // =====================================================
  // 7. FIND BEST ARBITRAGE CANDIDATE
  // =====================================================

  if (executablePools.length < 2 || !bestTrade) return { pass: false };

  console.log("");
  console.log("Trade Selection:");
  console.log("  ✅ Valid arbitrage candidate found");
  console.log("");

  // =====================================================
  // 8. Build Trade Candidate
  // =====================================================

  let tradeCandidate = null;

  if (bestTrade) {
    const buyPool = bestTrade.buyPool;
    const sellPool = bestTrade.sellPool;
    const eventType = inputToken.address.toLowerCase() === WETH.toLowerCase() ? "PUMP" : "DUMP";
    const tradeToken = eventType === "PUMP" ? outputToken : inputToken;
    const flashToken = topTokens.find(t => t.address.toLowerCase() === WETH.toLowerCase());

    tradeCandidate = {
      pair: pairName,
      eventBlock,
      flashToken,
      tradeToken,
      tokenIn: flashToken,
      tokenOut: tradeToken,
      eventDirection: `${inputToken.symbol} → ${outputToken.symbol}`,
      executionDirection: `${flashToken.symbol} → ${tradeToken.symbol} → ${flashToken.symbol}`,
      eventType,

      firstSwap: {
        pool: buyPool.address,
        tokenIn: flashToken,
        tokenOut: tradeToken,
        fee: Number(buyPool.fee),
        liquidity: buyPool.liquidity,
        quoteIn: buyPool.tradeability?.testAmountIn ?? 0n,
        quoteOut: buyPool.tradeability?.testAmountOut ?? 0n
      },

      secondSwap: {
        pool: sellPool.address,
        tokenIn: tradeToken,
        tokenOut: flashToken,
        fee: Number(sellPool.fee),
        liquidity: sellPool.liquidity,
        quoteIn: sellPool.tradeability?.testAmountOut ?? 0n,
        quoteOut: sellPool.tradeability?.wethReturned ?? 0n
      },

      spread: {
        difference: bestTrade.spread,
        percent: bestTrade.spreadPercent,
        requiredSpread: bestTrade.requiredSpread
      }
    };
  }

  // =====================================================
  // 9. Display Analysis
  // =====================================================

  if (tradeCandidate) {
    const buy = tradeCandidate.firstSwap;
    const sell = tradeCandidate.secondSwap;
    const token = tradeCandidate.tradeToken;
    const weth = tradeCandidate.flashToken;
    const buyIn = ethers.formatUnits(buy.quoteIn, weth.decimals);
    const buyOut = ethers.formatUnits(buy.quoteOut, token.decimals);
    const sellIn = ethers.formatUnits(sell.quoteIn, token.decimals);
    const sellOut = ethers.formatUnits(sell.quoteOut, weth.decimals);
    const spread = Number(tradeCandidate.spread?.percent ?? 0);
    const required = Number(tradeCandidate.spread?.requiredSpread ?? 0);

    border();
    console.log("📊 BEST TRADE CANDIDATE");
    border();

    console.log(`Event               : ${tradeCandidate.eventType}`);
    console.log(`Event Direction     : ${tradeCandidate.eventDirection}`);
    console.log(`Execution Direction : ${tradeCandidate.executionDirection}`);
    console.log(`Event Block         : ${tradeCandidate.eventBlock}`);
    console.log(`Flash Token         : ${weth.symbol}`);
    console.log(`Trade Token         : ${token.symbol}`);

    console.log("");
    console.log("Buy Pool:");
    console.log(`  Fee              : ${buy.fee} (${(buy.fee / 10000).toFixed(2)}%)`);
    console.log(`  Address          : ${shortAddress(buy.pool)}`);
    console.log(`  Test Quote       : ${buyIn} ${weth.symbol} → ${buyOut} ${token.symbol}`);

    console.log("");
    console.log("Sell Pool:");
    console.log(`  Fee              : ${sell.fee} (${(sell.fee / 10000).toFixed(2)}%)`);
    console.log(`  Address          : ${shortAddress(sell.pool)}`);
    console.log(`  Test Quote       : ${sellIn} ${token.symbol} → ${sellOut} ${weth.symbol}`);

    console.log("");
    console.log("Price Advantage (Quoter Test):");
    console.log(`  Buy Output       : ${buyOut} ${token.symbol}`);
    console.log(`  Sell Return      : ${sellOut} ${weth.symbol}`);
    console.log(`  Price Difference : ${spread >= 0 ? "+" : ""}${spread.toFixed(2)}%`);

    console.log("");
    console.log("Executable Quote Pre-check:");
    console.log(`  Quote Difference : ${spread >= 0 ? "+" : ""}${spread.toFixed(2)}%`);
    console.log(`  Required         : +${required.toFixed(2)}%`);
    console.log(`  Status           : ${spread >= required ? "✅ Passed" : "❌ Failed"}`);
    console.log("");
  }

  // =====================================================
  // 10. Return Result
  // =====================================================

  if (!tradeCandidate) return { pass: false };

  return {
    pass: true,
    eventInput: inputToken,
    eventOutput: outputToken,
    eventDirection: `${inputToken.symbol} → ${outputToken.symbol}`,
    tradeCandidate,

    trade: {
      buyPool: tradeCandidate.firstSwap,
      sellPool: tradeCandidate.secondSwap,
      tokenIn: tradeCandidate.firstSwap.tokenIn,
      tokenOut: tradeCandidate.firstSwap.tokenOut,

      firstSwap: {
        pool: tradeCandidate.firstSwap.pool,
        tokenIn: tradeCandidate.firstSwap.tokenIn,
        tokenOut: tradeCandidate.firstSwap.tokenOut,
        fee: tradeCandidate.firstSwap.fee,
        liquidity: tradeCandidate.firstSwap.liquidity
      },

      secondSwap: {
        pool: tradeCandidate.secondSwap.pool,
        tokenIn: tradeCandidate.secondSwap.tokenIn,
        tokenOut: tradeCandidate.secondSwap.tokenOut,
        fee: tradeCandidate.secondSwap.fee,
        liquidity: tradeCandidate.secondSwap.liquidity
      },

      spread: {
        difference: tradeCandidate.spread.difference,
        percent: tradeCandidate.spread.percent
      }
    },

    amountIn,
    eventBlock,
    poolAddress,

    routeContext: {
      finalPools: enrichedPools,
      eventBlock,
      baseToken: inputToken,
      targetToken: outputToken,
      tokens: topTokens,
      fee
    }
  };
}

// ─────────────────────────────────────────────
// CheckProfit will determine if there is a profitable path (Multi-Hop engine)
// ─────────────────────────────────────────────
async function checkProfit(ctx, params) {
  const { executionProvider: provider, signer, arbitrageContract, minProfit, quoter, factory } = ctx;
  const { tradeCandidate, eventBlock } = params;

  if (!provider) throw new Error("checkProfit missing provider");
  if (!tradeCandidate) {
    console.log("❌ Missing trade candidate");
    return { profitable: false };
  }

  const fmt = (value, decimals, digits = 6) => Number(ethers.formatUnits(value, decimals)).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const border = () => console.log(orange("═══════════════════════════════════════════════════════════"));

  const flashToken = tradeCandidate.flashToken;
  const tradeToken = tradeCandidate.tradeToken;
  const buySwap = tradeCandidate.firstSwap;
  const sellSwap = tradeCandidate.secondSwap;
  const flashDecimals = flashToken.decimals ?? 18;
  const tradeDecimals = tradeToken.decimals ?? 18;
  const profitCheckStart = performance.now();
  const PRICE_SCALE = 10n ** 18n;

  if (eventBlock == null) {
      throw new Error("checkProfit missing eventBlock");
    }

  const quoteBlock = eventBlock;

  border();
  console.log("💰 PROFIT CHECK");
  border();

  // =====================================================
  // TEST LOAN SIZES
  // =====================================================

  const flashAmountLimit = ethers.parseUnits("100", flashDecimals);
  const testSizes = generateLoanSizes(flashAmountLimit, flashDecimals);

  const results = [];
  let best = null;

  for (const amountIn of testSizes) {
    try {
      const amountBorrowed = amountIn;

    // =====================================================
    // EXACT QUOTER: WETH → LINK
    // =====================================================

    const tradeAmount = BigInt(
      (
        await quoter.quoteExactInputSingle.staticCall(
          flashToken.address,
          tradeToken.address,
          Number(buySwap.fee),
          amountBorrowed,
          0n,
          { blockTag: quoteBlock }
        )
      ).toString()
    );

    // =====================================================
    // EXACT QUOTER: LINK → WETH
    // =====================================================

    const amountReturned = BigInt(
      (
        await quoter.quoteExactInputSingle.staticCall(
          tradeToken.address,
          flashToken.address,
          Number(sellSwap.fee),
          tradeAmount,
          0n,
          { blockTag: quoteBlock }
        )
      ).toString()
    );

    // =====================================================
    // FLASH LOAN FEE
    // =====================================================

    const BALANCER_FLASH_FEE_BPS = 0n;
    const flashFee = amountBorrowed * BALANCER_FLASH_FEE_BPS / 10000n;
    const grossProfit = amountReturned - amountBorrowed;

    let gasCost = 0n;
    let gasEstimate = 0n;
    let gasPrice = 0n;

    try {
      const arb = arbitrageContract.connect(signer);
      const feeData = await provider.getFeeData();
      gasPrice = feeData.gasPrice ?? 0n;

      const cleanRoute = [
        {dex:0, tokenIn:buySwap.tokenIn.address, tokenOut:buySwap.tokenOut.address, fee:buySwap.fee},
        {dex:0, tokenIn:sellSwap.tokenIn.address, tokenOut:sellSwap.tokenOut.address, fee:sellSwap.fee}
      ];

      gasEstimate = await arb.executeTrade.estimateGas(
        flashToken.address,
        amountBorrowed,
        cleanRoute,
        minProfit
      );

      gasCost = gasEstimate * gasPrice;
    } catch (e) {
      continue;
    }

    const netProfit = grossProfit - flashFee - gasCost;

    const result = {
      size: ethers.formatUnits(amountBorrowed, flashDecimals),
      amountIn: amountBorrowed,
      buyAmount: tradeAmount,
      sellAmount: amountReturned,
      flashFee,
      grossProfit,
      gasEstimate,
      gasPrice,
      gasCost,
      netProfit
    };

    results.push(result);

    if (!best || netProfit > best.netProfit) best = result;

    } catch (e) {
      console.log(
        "❌ Profit calculation failed:",
        ethers.formatUnits(amountIn, flashDecimals),
        e.shortMessage || e.message
      );
    }
  }

  const profitCheckLatency = Math.round(performance.now() - profitCheckStart);

  if (!best) {
    console.log("❌ No valid loan calculations");
    return { profitable: false };
  }

  // =====================================================
  // FINAL PROFIT
  // =====================================================

  const repayment = best.amountIn + best.flashFee;
  const roi = Number(best.netProfit) / Number(best.amountIn) * 100;
  const profitable = best.netProfit >= minProfit;

  const block = eventBlock;
  const latestBlock = await provider.getBlockNumber();

  console.log(`Pair                 : ${flashToken.symbol}/${tradeToken.symbol}`);
  console.log(`Route                : ${buySwap.tokenIn.symbol} → ${buySwap.tokenOut.symbol} → ${sellSwap.tokenOut.symbol}`);
  console.log(`Pools                : ${(Number(buySwap.fee) / 10000).toFixed(2)}% → ${(Number(sellSwap.fee) / 10000).toFixed(2)}%`);
  console.log(`Candidate Source     : analyze()`);
  console.log(`Profit Source        : Exact Uniswap V3 Quoter`);
  console.log(`Profit Check Latency : ${profitCheckLatency} ms`);
  console.log(`Event Block          : ${eventBlock}`);
  console.log(`Quote Block          : ${quoteBlock}`);
  console.log(`Latest Block         : ${latestBlock}`);
  console.log(`Block Lag            : ${latestBlock - eventBlock}`);

  // =====================================================
  // LOAN TESTS
  // =====================================================

  results.sort((a, b) => a.netProfit === b.netProfit ? 0 : a.netProfit > b.netProfit ? -1 : 1);

  console.log("\nLoan Tests");
  console.log("──────────────────────────────────────────────────────────────────────────────");
  console.log(
    `Loan ${flashToken.symbol}`.padEnd(12) +
    `Buy Output ${tradeToken.symbol}`.padEnd(19) +
    `Sell Output ${flashToken.symbol}`.padEnd(20) +
    `Gross ${flashToken.symbol}`.padEnd(15) +
    `Gas ${flashToken.symbol}`.padEnd(13) +
    `Net ${flashToken.symbol}`.padEnd(15) +
    "ROI"
  );


  for (const [index, r] of results.slice(0, 3).entries()) {
    const roi = Number(r.netProfit) / Number(r.amountIn) * 100;

    const profitSign = r.netProfit >= 0n ? "+" : "";
    const status = r.netProfit >= minProfit ? "✅" : "❌";
    const mark = index === 0 ? " ★ Best" : "";

    const loan = fmt(r.amountIn, flashDecimals, 6);
    const buyOutput = fmt(r.buyAmount, tradeDecimals, 6);
    const sellOutput = fmt(r.sellAmount, flashDecimals, 8);
    const gross = `${r.grossProfit >= 0n ? "+" : ""}${fmt(r.grossProfit, flashDecimals, 8)}`;
    const gas = fmt(r.gasCost, flashDecimals, 8);
    const net = `${profitSign}${fmt(r.netProfit, flashDecimals, 8)}`;

    console.log(
      loan.padEnd(12) +
      `${buyOutput}`.padEnd(19) +
      `${sellOutput}`.padEnd(20) +
      `${gross}`.padEnd(15) +
      `${gas}`.padEnd(13) +
      `${net}`.padEnd(15) +
      `${roi.toFixed(2)}% ${status}${mark}`
    );
  }

  // =====================================================
  // BEST RESULT
  // =====================================================

  const bestRoi = Number(best.netProfit) / Number(best.amountIn) * 100;
  const bestProfitSign = best.netProfit >= 0n ? "+" : "";
  const bestGrossSign = best.grossProfit >= 0n ? "+" : "";
  let expectedUsdc = null;

  const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
  const USDC_DECIMALS = 6;
  const USDC_QUOTE_FEE = 500;

  if (best.netProfit > 0n && quoter) {
    try {
      expectedUsdc = BigInt((await quoter.quoteExactInputSingle.staticCall(
        flashToken.address,
        USDC,
        USDC_QUOTE_FEE,
        best.netProfit,
        0n,
        { blockTag: quoteBlock }
      )).toString());
    } catch (e) {
      expectedUsdc = null;
    }
  }

  console.log("");
  console.log("🏆 BEST RESULT");
  console.log("───────────────────────────────────────────────────────────");

  console.log(`Borrowed             : ${fmt(best.amountIn, flashDecimals, 6)} ${flashToken.symbol}`);

  console.log("");
  console.log(`Swap 1 — ${flashToken.symbol} → ${tradeToken.symbol}`);
  console.log(`Input                : ${fmt(best.amountIn, flashDecimals, 6)} ${flashToken.symbol}`);
  console.log(`Quoted Output        : ${fmt(best.buyAmount, tradeDecimals, 4)} ${tradeToken.symbol}`);
  console.log(
    `Math                 : ${fmt(best.amountIn, flashDecimals, 8)} ${flashToken.symbol} → ` +
    `${fmt(best.buyAmount, tradeDecimals, 8)} ${tradeToken.symbol}`
  );
  console.log("");
  console.log(`Swap 2 — ${tradeToken.symbol} → ${flashToken.symbol}`);
  console.log(`Input                : ${fmt(best.buyAmount, tradeDecimals, 4)} ${tradeToken.symbol}`);
  console.log(`Quoted Output        : ${fmt(best.sellAmount, flashDecimals, 6)} ${flashToken.symbol}`);
  console.log(
    `Math                 : ${fmt(best.buyAmount, tradeDecimals, 8)} ${tradeToken.symbol} → ` +
    `${fmt(best.sellAmount, flashDecimals, 8)} ${flashToken.symbol}`
  );

  console.log("");
  console.log(`Gross Profit         : ${bestGrossSign}${fmt(best.grossProfit, flashDecimals, 8)} ${flashToken.symbol}`);
  console.log(`Flash Fee            : -${fmt(best.flashFee, flashDecimals, 8)} ${flashToken.symbol}`);
  console.log(`Gas Estimate         : ${best.gasEstimate.toString()}`);
  console.log(`Gas Price            : ${ethers.formatUnits(best.gasPrice, "gwei")} gwei`);
  console.log(`Gas Cost             : -${fmt(best.gasCost, flashDecimals, 8)} ${flashToken.symbol}`);

  console.log("───────────────────────────────────────────────────────────");

  console.log(`Net Profit           : ${bestProfitSign}${fmt(best.netProfit, flashDecimals, 8)} ${flashToken.symbol}`);
  console.log(`ROI                  : ${bestRoi.toFixed(2)}%`);
  console.log(`Minimum Required     : ${fmt(minProfit, flashDecimals, 8)} ${flashToken.symbol}`);
  console.log(`USDC Value           : ${expectedUsdc !== null ? `+$${fmt(expectedUsdc, USDC_DECIMALS, 2)}` : "N/A"}`);
  console.log(`Decision             : ${profitable ? "✅ EXECUTE" : "❌ SKIP"}`);
  console.log("");

  

  ////////////////////////////////////////////

  // =====================================================
  // 🧪 TEST: EXACT UNISWAP V3 WETH → LINK → WETH QUOTE
  // =====================================================

  console.log("───────────────────────────────────────────────────────────");
  console.log(`🧪 EXACT QUOTER TEST (${flashToken.symbol} → ${tradeToken.symbol} → ${flashToken.symbol})`);
  console.log("───────────────────────────────────────────────────────────");

  let exactQuoteBuy = null;
  let exactQuoteSell = null;
  let exactQuoteReturn = null;
  let exactQuoteProfit = null;

  // =====================================================
  // 🔎 QUOTER ROUTE DEBUG
  // =====================================================

  console.log("");
  console.log("🔎 QUOTER ROUTE DEBUG");
  console.log("───────────────────────────────────────────────────────────");
  console.log(`Quote Block          : ${quoteBlock}`);

  // =====================================================
  // 📈 SPOT PRICE DEBUG
  // =====================================================

  try {
    const spotBuy = await quoter.quoteExactInputSingle.staticCall(
      flashToken.address,
      tradeToken.address,
      Number(buySwap.fee),
      ethers.parseUnits("1", flashDecimals),
      0n,
      { blockTag: quoteBlock }
    );

    const spotSell = await quoter.quoteExactInputSingle.staticCall(
      tradeToken.address,
      flashToken.address,
      Number(sellSwap.fee),
      ethers.parseUnits("1", tradeDecimals),
      0n,
      { blockTag: quoteBlock }
    );

    const buyRateWethToToken = Number(ethers.formatUnits(spotBuy, tradeDecimals));
    const sellRateTokenToWeth = Number(ethers.formatUnits(spotSell, flashDecimals));
    const sellRateWethToToken = 1 / sellRateTokenToWeth;

    console.log("");
    console.log("📈 EXACT 1-UNIT QUOTES");
    console.log("───────────────────────────────────────────────────────────");
    console.log(`Buy Pool Quote       : 1 ${flashToken.symbol} → ` + `${buyRateWethToToken.toFixed(8)} ${tradeToken.symbol}`);
    console.log(`Sell Pool Equivalent : 1 ${flashToken.symbol} → ` + `${sellRateWethToToken.toFixed(8)} ${tradeToken.symbol}`);

    console.log(`Buy Pool             : ${buySwap.pool}`);
    console.log(`Sell Pool            : ${sellSwap.pool}`);
    console.log(`Buy Fee              : ${Number(buySwap.fee)} (${(Number(buySwap.fee) / 10000).toFixed(2)}%)`);
    console.log(`Sell Fee             : ${Number(sellSwap.fee)} (${(Number(sellSwap.fee) / 10000).toFixed(2)}%)`);

  } catch (e) {
    console.log("❌ Spot price debug failed:", e.shortMessage || e.message);
  }

  const analyzeBuyPool = buySwap.pool;
  const analyzeSellPool = sellSwap.pool;

  let factoryBuyPool = null;
  let factorySellPool = null;

  console.log("");
  console.log("BUY LEG");
  console.log(`Token In             : ${flashToken.address} (${flashToken.symbol})`);
  console.log(`Token Out            : ${tradeToken.address} (${tradeToken.symbol})`);
  console.log(`Fee                  : ${Number(buySwap.fee)}`);
  console.log(`analyze() Pool       : ${analyzeBuyPool || "UNKNOWN"}`);

  console.log("");
  console.log("SELL LEG");
  console.log(`Token In             : ${tradeToken.address} (${tradeToken.symbol})`);
  console.log(`Token Out            : ${flashToken.address} (${flashToken.symbol})`);
  console.log(`Fee                  : ${Number(sellSwap.fee)}`);
  console.log(`analyze() Pool       : ${analyzeSellPool || "UNKNOWN"}`);

  // =====================================================
  // 🏭 VERIFY POOLS THROUGH UNISWAP V3 FACTORY
  // =====================================================

  if (factory) {
    try {
      factoryBuyPool = await factory.getPool(flashToken.address, tradeToken.address, Number(buySwap.fee), { blockTag: quoteBlock });
      factorySellPool = await factory.getPool(tradeToken.address, flashToken.address, Number(sellSwap.fee), { blockTag: quoteBlock });

      const buyPoolMatch = analyzeBuyPool && factoryBuyPool && analyzeBuyPool.toLowerCase() === factoryBuyPool.toLowerCase();
      const sellPoolMatch = analyzeSellPool && factorySellPool && analyzeSellPool.toLowerCase() === factorySellPool.toLowerCase();

      console.log("");
      console.log("🏭 FACTORY POOL VERIFICATION");
      console.log("───────────────────────────────────────────────────────────");
      console.log(`BUY Pool — analyze() : ${analyzeBuyPool || "UNKNOWN"}`);
      console.log(`BUY Pool — factory   : ${factoryBuyPool || "UNKNOWN"}`);
      console.log(`BUY Pool Match       : ${buyPoolMatch ? "✅ YES" : "❌ NO"}`);
      console.log("");
      console.log(`SELL Pool — analyze(): ${analyzeSellPool || "UNKNOWN"}`);
      console.log(`SELL Pool — factory  : ${factorySellPool || "UNKNOWN"}`);
      console.log(`SELL Pool Match      : ${sellPoolMatch ? "✅ YES" : "❌ NO"}`);

      if (!buyPoolMatch || !sellPoolMatch) {
        console.log("");
        console.log("🚨 POOL MISMATCH DETECTED");
        console.log("analyze() and Uniswap Factory resolved different pools.");
      }
    } catch (e) {
      console.log("❌ Factory pool verification failed:", e.shortMessage || e.message);
    }
  } else {
    console.log("⚠️ Factory unavailable - pool verification skipped");
  }

  if (quoter) {
    try {

      // -------------------------------------------------
      // STEP 1: WETH → LINK
      // -------------------------------------------------

      exactQuoteBuy = BigInt((await quoter.quoteExactInputSingle.staticCall(
        flashToken.address,
        tradeToken.address,
        Number(buySwap.fee),
        best.amountIn,
        0n,
        { blockTag: quoteBlock }
      )).toString());

      console.log(`Quoter Buy           : ${fmt(best.amountIn, flashDecimals, 6)} ${flashToken.symbol} → ${fmt(exactQuoteBuy, tradeDecimals, 6)} ${tradeToken.symbol}`);

      // -------------------------------------------------
      // STEP 2: LINK → WETH
      // -------------------------------------------------

      exactQuoteSell = BigInt((await quoter.quoteExactInputSingle.staticCall(
        tradeToken.address,
        flashToken.address,
        Number(sellSwap.fee),
        exactQuoteBuy,
        0n,
        { blockTag: quoteBlock }
      )).toString());

      console.log(`Quoter Sell          : ${fmt(exactQuoteBuy, tradeDecimals, 6)} ${tradeToken.symbol} → ${fmt(exactQuoteSell, flashDecimals, 6)} ${flashToken.symbol}`);

      // -------------------------------------------------
      // EXACT RESULT
      // -------------------------------------------------

      exactQuoteReturn = exactQuoteSell;
      exactQuoteProfit = exactQuoteReturn - best.amountIn;

      console.log("");
      console.log(`Exact Quoter Return  : ${fmt(exactQuoteReturn, flashDecimals, 8)} ${flashToken.symbol}`);
      console.log(`Exact Gross Profit   : ${exactQuoteProfit >= 0n ? "+" : ""}${fmt(exactQuoteProfit, flashDecimals, 8)} ${flashToken.symbol}`);

      // -------------------------------------------------
      // COMPARE AGAINST analyze()
      // -------------------------------------------------

      const analyzeReturnDifference = exactQuoteReturn - best.sellAmount;

      console.log("");
      console.log("COMPARE TO analyze()");
      console.log("───────────────────────────────────────────────────────────");
      console.log(`analyze() Return     : ${fmt(best.sellAmount, flashDecimals, 8)} ${flashToken.symbol}`);
      console.log(`Exact Quoter Return  : ${fmt(exactQuoteReturn, flashDecimals, 8)} ${flashToken.symbol}`);
      console.log(`Difference           : ${analyzeReturnDifference >= 0n ? "+" : ""}${fmt(analyzeReturnDifference, flashDecimals, 8)} ${flashToken.symbol}`);

      // -------------------------------------------------
      // PRICE IMPACT / EFFECTIVE RATE
      // -------------------------------------------------

      console.log("");
      console.log("EFFECTIVE EXECUTION");
      console.log("───────────────────────────────────────────────────────────");

      const exactRate = exactQuoteReturn * PRICE_SCALE / best.amountIn;
      const analyzeRate = best.sellAmount * PRICE_SCALE / best.amountIn;

      console.log(`analyze() Return Rate: ${ethers.formatUnits(analyzeRate, 18)} ${flashToken.symbol}/${flashToken.symbol}`);
      console.log(`Exact Return Rate    : ${ethers.formatUnits(exactRate, 18)} ${flashToken.symbol}/${flashToken.symbol}`);

    } catch (e) {
      console.log("❌ Exact WETH quoter test failed:", e.shortMessage || e.message);
    }
  } else {
    console.log("⚠️ Quoter unavailable - exact quote test skipped");
  }

  console.log("───────────────────────────────────────────────────────────");

  ///////////////////////////////////////////////////////

  if (!profitable) {
    return {
      profitable: false,
      netProfit: best.netProfit
    };
  }

  return {
    profitable: true,
    tokenIn: flashToken.address,
    flashAmount: best.amountIn,
    flashToken,
    tradeToken,
    executionRoute: [tradeCandidate.firstSwap, tradeCandidate.secondSwap],
    netProfit: best.netProfit,
    expectedUsdc: expectedUsdc,
    grossProfit: best.grossProfit,
    flashFee: best.flashFee,
    repayment,
    roi: bestRoi
  };
}

// ─────────────────────────────────────────
// EXECUTE TRADE (2-TOKEN OR TRIANGULAR)
// ─────────────────────────────────────────
async function executeTrade(ctx, params) {

    const { signer, arbitrageContract, minProfit, executionProvider: provider, quoter} = ctx;
    const { tokenIn, flashAmount, executionRoute, netProfit, flashToken, expectedUsdc} = params;

    const fmt = (value, decimals, digits = 4) => Number(ethers.formatUnits(value, decimals)).toFixed(digits);
    const USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
    const USDC_DECIMALS = 6;

    const ORANGE = "\x1b[38;5;208m";
    const RESET = "\x1b[0m";

    const border = () => console.log(ORANGE + "═══════════════════════════════════════════════════════════" + RESET);

    const addr = v => {
        if (!v) return;
        if (typeof v === "string") return v;
        return v.address ?? v.token ?? v.tokenIn;
    };

    const norm = (v, label="unknown") => {
        const a = addr(v);
        if (!a) throw new Error(`Missing address for ${label}`);
        return a.toLowerCase();
    };

    try {

        border();
        console.log("🚀 EXECUTE TRADE");
        border();

        if (!tokenIn) throw new Error("Missing tokenIn");
        if (!flashAmount) throw new Error("Missing flashAmount");
        if (!Array.isArray(executionRoute)) throw new Error("Invalid route");
        if (executionRoute.length < 2) throw new Error("Route requires 2 swaps");
        if (!signer) throw new Error("Missing signer");
        if (!arbitrageContract) throw new Error("Missing contract");

        console.log("📍 ROUTE");

        executionRoute.forEach((s,i)=> console.log(`${i}: ${s.tokenIn.symbol} → ${s.tokenOut.symbol} (${s.fee})`));

        const path = executionRoute.map((s,i)=> norm(s.tokenIn,`route ${i} input`));
        path.push(norm(executionRoute.at(-1).tokenOut, "route final output"));

        if (path[0] !== path.at(-1))throw new Error(`Invalid circular route ${path[0]} → ${path.at(-1)}`);

        if (ctx.debug)
            console.log("🔍 Route:",path[0],"→",path.at(-1));

        const cleanRoute = executionRoute.map((s,i)=>({dex:0, tokenIn:norm(s.tokenIn,`route ${i} input`), tokenOut:norm(s.tokenOut,`route ${i} output`), fee:s.fee}));

        console.log(`\n🛣 Route built (${cleanRoute.length} hops)`);

        const arb = arbitrageContract.connect(signer);

        console.log("\n🧪 Simulating transaction...");

        try {

            const gasEstimate = await arb.executeTrade.estimateGas(tokenIn, flashAmount, cleanRoute, minProfit);
            console.log("Estimated gas:",gasEstimate.toString());
            console.log("✅ Simulation passed");

        } catch(e) {
            console.error("❌ Simulation failed");
            console.error(e.reason ?? e.shortMessage ?? e.message);
            throw e;

        }

        console.log("\n📨 Sending transaction...");

        const tx = await arb.executeTrade(tokenIn, flashAmount, cleanRoute, minProfit);

        if(ctx.refs){
            ctx.refs.lastSubmittedTxHash = tx.hash.toLowerCase();
            ctx.refs.lastTradeTime = Date.now();
        }

        console.log("TX Hash:",tx.hash);

        const receipt = await tx.wait();

        if(ctx.refs){ctx.refs.lastTradeBlock = receipt.blockNumber}

        console.log("\n========== RECEIPT ==========");
        console.log("Status:", receipt.status);
        console.log("Gas used:", receipt.gasUsed.toString());

        if(!receipt || receipt.status !== 1) throw new Error("Transaction reverted");

        // =====================================================
        // PROFIT RESULT
        // =====================================================

        console.log("📊 PROFIT RESULT");

        const profitDecimals = flashToken.decimals ?? 18;

        // -----------------------------------------------------
        // FIND REALIZED PROFIT EVENT
        // -----------------------------------------------------

        let realizedProfit = null;

        for (const log of receipt.logs) {
            try {
                const parsed = arbitrageContract.interface.parseLog(log);

                if (parsed?.name === "Profit") {
                    realizedProfit = BigInt(parsed.args[0].toString());
                    break;
                }
            } catch {}
        }

        // -----------------------------------------------------
        // ACTUAL GAS COST
        // -----------------------------------------------------

        let actualGasCost = null;

        if (receipt.gasPrice != null) {
            actualGasCost = receipt.gasUsed * receipt.gasPrice;
        }

        // -----------------------------------------------------
        // REALIZED NET PROFIT
        // -----------------------------------------------------

        let realizedNetProfit = null;
        let realizedUsdc = null;

        if (realizedProfit !== null) {

            realizedNetProfit = actualGasCost !== null ? realizedProfit - actualGasCost : realizedProfit;

            // -------------------------------------------------
            // REALIZED NET PROFIT → USDC
            // -------------------------------------------------

            if (quoter && realizedNetProfit > 0n) {
                try {
                    realizedUsdc = BigInt(
                        (
                            await quoter.quoteExactInputSingle.staticCall(
                                flashToken.address,
                                USDC,
                                500,
                                realizedNetProfit,
                                0n
                            )
                        ).toString()
                    );
                } catch (e) {
                    console.log(`  ⚠️ USDC quote failed - ${e.shortMessage || e.message}`);
                }
            }
        }

        // -----------------------------------------------------
        // EXPECTED
        // -----------------------------------------------------

        console.log("\nExpected:");
        console.log(`  Net Profit       : +${fmt(netProfit, profitDecimals)} ${flashToken.symbol}`);
        console.log(`  USDC Value       : ${expectedUsdc != null ? `+$${fmt(expectedUsdc, USDC_DECIMALS, 2)}` : "N/A"}`);

        // -----------------------------------------------------
        // REALIZED
        // -----------------------------------------------------

        if (realizedNetProfit !== null) {

            console.log("\nRealized:");
            console.log(`  Gross Profit     : +${fmt(realizedProfit, profitDecimals)} ${flashToken.symbol}`);
            console.log(`  Actual Gas Cost  : -${fmt(actualGasCost ?? 0n, profitDecimals)} ${flashToken.symbol}`);
            console.log(`  Net Profit       : +${fmt(realizedNetProfit, profitDecimals)} ${flashToken.symbol}`);
            console.log(`  USDC Value       : ${realizedUsdc != null ? `+$${fmt(realizedUsdc, USDC_DECIMALS, 2)}` : "N/A"}`);

            // -------------------------------------------------
            // DIFFERENCE
            // -------------------------------------------------

            const profitDifference = realizedNetProfit - netProfit;
            const usdcDifference = expectedUsdc != null && realizedUsdc != null ? realizedUsdc - expectedUsdc : null;

            console.log("\nDifference between Expected and Realized Profit:");
            console.log(`  WETH : ${profitDifference >= 0n ? "+" : ""}${fmt(profitDifference, profitDecimals)} ${flashToken.symbol}`);
            console.log(`  USDC : ${usdcDifference != null ? `${usdcDifference >= 0n ? "+" : ""}$${fmt(usdcDifference, USDC_DECIMALS, 2)}` : "N/A"}`);

        } else {

            console.log("\nRealized:");
            console.log("  ⚠️ Profit event not found");
        }

        if(ctx.debugEvents){
            for(const log of receipt.logs){
                try{
                    const parsed = arbitrageContract.interface.parseLog(log);
                    console.log("EVENT:", parsed.name, parsed.args);
                }catch{}
            }
        }

        console.log("==============================\n");

        if(!receipt || receipt.status !== 1)
            throw new Error("Transaction reverted");

        border();
        console.log("✅ EXECUTE TRADE COMPLETE");
        border();

        return {
            hash:tx.hash,
            receipt
        };

    } catch(err) {

        console.error("\n❌ EXECUTE TRADE ERROR");
        console.error(err);
        throw err;
    }
}

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
main().catch(console.error);

// !! Swapping over to a 1 Dex bot now!! Made changes to analzye, all working now with Quoter