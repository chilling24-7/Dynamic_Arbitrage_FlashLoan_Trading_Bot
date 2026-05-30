/**
 * ────────────────────────────────────────────────────────────────────────────────
 * Arbitrage Bot for Uniswap and Sushiswap
 * ────────────────────────────────────────────────────────────────────────────────
 *
 * Features:
 * - Monitors price differences between two tokens (e.g., WETH/SHIB) on Uniswap and Sushiswap
 * - Determines arbitrage direction and profitability
 * - Executes 2-token arbitrage (supports 3-token in future)
 * - Handles dummy token for 2-token trades
 * - Includes cooldown and safety mechanisms
 *
 * Notes:
 * - Fully BigInt compatible
 * - Compatible with Ethers v6
 */

require("./helpers/server");
require("dotenv").config();

const { ethers } = require("ethers");
const chalk = require("chalk");
const config = require("./config.json");

// Now destructure after the config is loaded
const { PROJECT_SETTINGS } = config;

const {
  determineNetwork,
  getSigner,
  getOrCreatePairContract,
  evaluateLiquidity,
  getReserves,
  getWethReserve,
  estimateMaxProfit,
  calculateOptimalArbitrageTrade,
  getFlashLoanSize,
} = require("./helpers/helpers");

const { provider, uFactory, sFactory, uRouter, sRouter, arbitrage } =
  require("./helpers/initialization");

const topTokens = require("./helpers/topTokens");
const REQUIRE_MEMPOOL_MATCH = true;
let lastMempoolEvent = Date.now();
let isResetting = false;

// Simulate orange color
const orange = chalk.rgb(255, 140, 0);

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
  // ============================================================
  // 1️⃣ ENVIRONMENT
  // ============================================================
  const isLocal = PROJECT_SETTINGS.isLocal;
  console.log(`Running in ${isLocal ? "LOCAL FORK" : "LIVE MAINNET"} mode`);

  // ============================================================
  // 2️⃣ PROVIDERS
  // ============================================================
  let executionProvider;
  let monitoringProvider;

  if (isLocal) {
    executionProvider = new ethers.JsonRpcProvider(
      process.env.LOCAL_RPC_URL || "http://127.0.0.1:8545"
    );
    monitoringProvider = executionProvider;
  } else {
    executionProvider = new ethers.JsonRpcProvider(
      `https://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    );

    monitoringProvider = new ethers.WebSocketProvider(
      `wss://eth-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`
    );

    monitoringProvider.on("error", (err) => {
      console.error("WebSocket Error:", err);
    });
  }

  // ============================================================
  // 3️⃣ MONITORING UI STATE
  // ============================================================
  let monitoringInterval;
  let monitoringPaused = false;
  let dots = 0;

  const startMonitoring = () => {
    if (monitoringInterval) return;

    monitoringInterval = setInterval(() => {
      if (!monitoringPaused) {
        dots = (dots + 1) % 7;
        process.stdout.write(`\r⏳ Monitoring${".".repeat(dots)}   `);
      }
    }, 500);
  };

  const pauseMonitoring = () => {
    monitoringPaused = true;
    process.stdout.write("\r                     \r");
  };

  const resumeMonitoring = () => {
    monitoringPaused = false;
    if (!monitoringInterval) startMonitoring();
  };

  // ============================================================
  // 4️⃣ NETWORK DETECTION
  // ============================================================
  const { type, startBlock } = await determineNetwork(
    executionProvider,
    null,
    isLocal
  );

  console.log(`Network type: ${type}`);
  const networkType = type;

  // ============================================================
  // 5️⃣ SIGNER + FLASH LOAN SIZE
  // ============================================================
  const signer = await getSigner(type, executionProvider);
  const FLASH_LOAN_SIZE = getFlashLoanSize(type);

  // ============================================================
  // 6️⃣ LOAD TOKENS
  // ============================================================
  let loadedTokens = 0;
  for (const token of topTokens) {
    try {
      token.address = ethers.getAddress(token.address.toLowerCase());
      token.contract = new ethers.Contract(
        token.address,
        ERC20_ABI,
        executionProvider
      );

      const code = await executionProvider.getCode(token.address);

      if (code !== "0x") {
        try {
          token.decimals = BigInt(await token.contract.decimals());
        } catch {
          token.decimals = 18n;
        }

        try {
          token.symbol = await token.contract.symbol();
        } catch {}
      }

      loadedTokens++;
    } catch (err) {
      console.error(`Error loading token ${token.symbol}:`, err);
    }
  }

  console.log(`✅ Loaded ${loadedTokens} tokens`);

  const usdcToken = {
    address: process.env.USDC,
    symbol: "USDC",
    decimals: 6n
  };

  // ============================================================
  // 7️⃣ PAIR DISCOVERY (WITH CACHING AND LAST-PROCESSED BLOCKS)
  // ============================================================
  
  const discoveredPairsMap = new Map();
  const pairLiquidity = {};
  const reserveCache = new Map();          // cache reserves
  const routingCache = new Map();          // cache routing score
  const lastProcessedBlockPerPair = new Map(); // track last processed block

  const WETH = ethers.getAddress(process.env.WETH.toLowerCase());
  const USDC = ethers.getAddress(process.env.USDC.toLowerCase());
  const DAI  = ethers.getAddress(process.env.DAI.toLowerCase());
  const USDT = ethers.getAddress(process.env.USDT.toLowerCase());

  let bridgeFull = 0, bridgePartial = 0, bridgeMinimal = 0, bridgeNone = 0;

  const wethToken = topTokens.find(t => t.address.toLowerCase() === WETH.toLowerCase());
  if (!wethToken) throw new Error("❌ WETH not found in topTokens");

  // -----------------------------
  // 🔹 Refresh / Update Function (optimized)
  // -----------------------------
  const refreshPairs = async () => {
    bridgeFull = bridgePartial = bridgeMinimal = bridgeNone = 0; // reset bridge counters
    const now = Date.now();

    // Get all WETH pairs to refresh (existing discovered + new undiscovered)
    const wethPairsToUpdate = topTokens
      .filter(t => t.address.toLowerCase() !== WETH.toLowerCase())
      .map(token => ({ tokenA: token, tokenB: wethToken }));

    // Refresh each WETH pair
    await Promise.all(wethPairsToUpdate.map(async ({ tokenA, tokenB }) => {
      const pairKey = [tokenA.address, tokenB.address].sort().join("_");
      const existingPair = discoveredPairsMap.get(pairKey);

      try {
        const uPair = await getOrCreatePairContract(uFactory, tokenA.address, tokenB.address, monitoringProvider);
        const sPair = await getOrCreatePairContract(sFactory, tokenA.address, tokenB.address, monitoringProvider);
        if (!uPair && !sPair) return; // no pair exists

        // canonical token order
        const chainToken0 = uPair ? await uPair.token0() : await sPair.token0();
        let actualToken0 = tokenA, actualToken1 = tokenB;
        if (chainToken0.toLowerCase() === tokenB.address.toLowerCase()) {
          [actualToken0, actualToken1] = [tokenB, tokenA];
        }

        const uniExists = !!uPair;
        const sushiExists = !!sPair;
        const isOneSided = uniExists !== sushiExists;
        const isDirect = uniExists && sushiExists;

        // -----------------------------
        // Reserves / Liquidity
        let cachedReserves = reserveCache.get(pairKey);
        if (!cachedReserves || now - cachedReserves.lastUpdated > 5000) {
          const uRes = uPair ? await getReserves(uFactory, actualToken0, actualToken1, monitoringProvider) : cachedReserves?.uReserves ?? null;
          const sRes = sPair ? await getReserves(sFactory, actualToken0, actualToken1, monitoringProvider) : cachedReserves?.sReserves ?? null;
          cachedReserves = { uReserves: uRes, sReserves: sRes, lastUpdated: now };
          reserveCache.set(pairKey, cachedReserves);
        }

        const { uReserves, sReserves } = cachedReserves;
        const minTradeSize = 10n ** 16n;
        const minTokenReserve = 10n ** BigInt(actualToken0.decimals);

        const uLiquidityValid = uReserves
          ? evaluateLiquidity({ reserveBase: BigInt(uReserves.reserveA), minTradeSize, minTokenReserve, dexName: `Uniswap ${actualToken0.symbol}/${actualToken1.symbol}` }).valid
          : false;
        const sLiquidityValid = sReserves
          ? evaluateLiquidity({ reserveBase: BigInt(sReserves.reserveA), minTradeSize, minTokenReserve, dexName: `Sushi ${actualToken0.symbol}/${actualToken1.symbol}` }).valid
          : false;

        const canTrade = (uniExists && sushiExists) ? uLiquidityValid && sLiquidityValid : uLiquidityValid || sLiquidityValid;
        pairLiquidity[pairKey] = canTrade ? "OK" : "LOW";

        // -----------------------------
        // 🌉 Bridge coverage for one-sided WETH pairs
        // -----------------------------
        let bridgeCount = 0;
        let hasUSDC = false, hasDAI = false, hasUSDT = false;

        // Only check bridge tokens if the pair is one-sided
        if (isOneSided) {
          const nonWETHToken = actualToken0.address.toLowerCase() === WETH.toLowerCase() ? actualToken1 : actualToken0;

          const uPairUSDC = await getOrCreatePairContract(uFactory, nonWETHToken.address, USDC, monitoringProvider);
          const sPairUSDC = await getOrCreatePairContract(sFactory, nonWETHToken.address, USDC, monitoringProvider);
          const uPairDAI  = await getOrCreatePairContract(uFactory, nonWETHToken.address, DAI, monitoringProvider);
          const sPairDAI  = await getOrCreatePairContract(sFactory, nonWETHToken.address, DAI, monitoringProvider);
          const uPairUSDT = await getOrCreatePairContract(uFactory, nonWETHToken.address, USDT, monitoringProvider);
          const sPairUSDT = await getOrCreatePairContract(sFactory, nonWETHToken.address, USDT, monitoringProvider);

          hasUSDC = !!uPairUSDC || !!sPairUSDC;
          hasDAI  = !!uPairDAI  || !!sPairDAI;
          hasUSDT = !!uPairUSDT || !!sPairUSDT;

          bridgeCount = (hasUSDC ? 1 : 0) + (hasDAI ? 1 : 0) + (hasUSDT ? 1 : 0);
        }

        // Update global bridge counters
        if (bridgeCount === 3) bridgeFull++;
        else if (bridgeCount === 2) bridgePartial++;
        else if (bridgeCount === 1) bridgeMinimal++;
        else if (isOneSided) bridgeNone++;

        // -----------------------------
        // 🧠 ROUTING SCORE UPDATE (ENHANCED BUT SAFE)
        // -----------------------------

        let routingScore = 0;

        // -----------------------------
        // 🚨 HARD ELIGIBILITY GATE (UNCHANGED BEHAVIOR)
        // -----------------------------
        const isEligible =
          canTrade &&
          (!isOneSided || bridgeCount > 0);

        if (!isEligible) {
          routingScore = 0;
          pairLiquidity[pairKey] = "LOW";
        } else {

          // -----------------------------
          // base liquidity signal
          // -----------------------------
          let liquidityScore = canTrade ? 20 : 0;

          if (isOneSided) {
            liquidityScore = Math.floor(liquidityScore * 0.5);
          }

          // -----------------------------
          // dex coverage signal
          // -----------------------------
          let coverageScore = 0;

          if (uniExists && sushiExists) coverageScore = 15;
          else if (uniExists || sushiExists) coverageScore = 7;

          // -----------------------------
          // bridge signal
          // -----------------------------
          const bridgeScore = isOneSided
            ? Math.min(bridgeCount, 3)
            : 6;

          // =====================================================
          // 🔥 NEW ADDITIONS (SAFE NON-BREAKING ENHANCEMENTS)
          // =====================================================

          // -----------------------------
          // 1. Liquidity depth quality
          // -----------------------------
          const sharedLiquidity = canTrade
            ? (uReserves?.reserve0 && sReserves?.reserve0
                ? (BigInt(
                    uReserves.reserve0 < uReserves.reserve1
                      ? uReserves.reserve0
                      : uReserves.reserve1
                  ) <
                  BigInt(
                    sReserves.reserve0 < sReserves.reserve1
                      ? sReserves.reserve0
                      : sReserves.reserve1
                  )
                    ? BigInt(
                        uReserves.reserve0 < uReserves.reserve1
                          ? uReserves.reserve0
                          : uReserves.reserve1
                      )
                    : BigInt(
                        sReserves.reserve0 < sReserves.reserve1
                          ? sReserves.reserve0
                          : sReserves.reserve1
                      ))
                : 0n)
            : 0n;

          const depthScore = canTrade
            ? Math.min(15, Number(sharedLiquidity / 10n ** 16n))
            : 0;

          // -----------------------------
          // 2. Reserve balance quality
          // -----------------------------
          let balanceScore = 0;

          if (uReserves && sReserves) {
            const uMin =
              uReserves.reserve0 < uReserves.reserve1
                ? uReserves.reserve0
                : uReserves.reserve1;

            const uMax =
              uReserves.reserve0 > uReserves.reserve1
                ? uReserves.reserve0
                : uReserves.reserve1;

            const sMin =
              sReserves.reserve0 < sReserves.reserve1
                ? sReserves.reserve0
                : sReserves.reserve1;

            const sMax =
              sReserves.reserve0 > sReserves.reserve1
                ? sReserves.reserve0
                : sReserves.reserve1;

            const uRatio = uMax > 0n ? Number((uMin * 100n) / uMax) : 0;
            const sRatio = sMax > 0n ? Number((sMin * 100n) / sMax) : 0;

            balanceScore = Math.floor((uRatio + sRatio) / 8);
          }

          // -----------------------------
          // 3. Stability bonus
          // -----------------------------
          let stableLike = 0;

          if (hasUSDC && hasUSDT && hasDAI) stableLike = 10;
          else if (hasUSDC || hasUSDT || hasDAI) stableLike = 5;

          // -----------------------------
          // RAW SCORE (NO ARTIFICIAL NORMALIZATION YET)
          // -----------------------------
          const rawScore =
            liquidityScore +
            coverageScore +
            bridgeScore +
            depthScore +
            balanceScore +
            stableLike;

          // -----------------------------
          // FINAL NORMALIZATION (FIXED SCALE)
          // -----------------------------

          // instead of compressing everything, we clamp only
          routingScore = Math.min(30, Math.floor(rawScore * 0.5));
        }

        // -----------------------------
        // Update discoveredPairs
        const pairObj = {
            pairName: `${actualToken0.symbol}/${actualToken1.symbol}`,
            token0: actualToken0,
            token1: actualToken1,
            uPair,
            sPair,
            uniExists,
            sushiExists,
            isOneSided,
            isDirect,
            hasUSDC,
            hasDAI,
            hasUSDT,
            bridgeCount,
            routingScore,
            liquiditySnapshot: {
                canTrade,
                uLiquidityValid,
                sLiquidityValid,
                uReserve: uReserves?.reserveA ?? null,
                sReserve: sReserves?.reserveA ?? null
            }
        };

        
        if (!existingPair) {
          discoveredPairsMap.set(pairKey, pairObj);
        } else {
          Object.assign(existingPair, pairObj);
        }

        lastProcessedBlockPerPair.set(pairKey, startBlock);

        } catch (err) {
          console.warn(`Pair error ${tokenA.symbol}/${tokenB.symbol}:`, err.message);
        }
      }));
    };

  // -----------------------------
  // 🔄 Start periodic refresh every 5 seconds
  // -----------------------------

  const getDiscoveredPairs = () => [...discoveredPairsMap.values()];

  setInterval(async () => {
    try {
      await refreshPairs();
    } catch (err) {
      console.error("refreshPairs error:", err);
    }
  }, 5000);

  await refreshPairs(); // initial refresh

  // ✅ Keep one-sided map for swaps or other logic
  const oneSidedPairsMap = {};

  for (const p of getDiscoveredPairs()) {
    if (p.isOneSided) {
      const pairKey = [p.token0.address, p.token1.address]
        .sort()
        .join("_");

      oneSidedPairsMap[pairKey] = true;
    }
  }

  // -----------------------------
  // 🔄 PERIODIC LIQUIDITY UPDATE
  // -----------------------------

  let updatingLiquidity = false;

  const updateLiquidity = async () => {
    if (updatingLiquidity) return;

    updatingLiquidity = true;

    try {
      for (const p of getDiscoveredPairs()) {
        const { token0, token1, uPair, sPair } = p;

        if (!uPair && !sPair) continue;

        const pairKey = [token0.address, token1.address]
          .sort()
          .join("_");

        try {
          const cachedReserves = reserveCache.get(pairKey);

          if (
            !cachedReserves ||
            Date.now() - cachedReserves.lastUpdated > 5000
          ) {
            const uRes = uPair
              ? await getReserves(
                  uFactory,
                  token0,
                  token1,
                  monitoringProvider
                )
              : null;

            const sRes = sPair
              ? await getReserves(
                  sFactory,
                  token0,
                  token1,
                  monitoringProvider
                )
              : null;

            reserveCache.set(pairKey, {
              uReserves: uRes,
              sReserves: sRes,
              lastUpdated: Date.now()
            });
          }

          const { uReserves, sReserves } =
            reserveCache.get(pairKey);

          const maxReserve =
            BigInt(uReserves?.reserveA || 0n) >
            BigInt(sReserves?.reserveA || 0n)
              ? BigInt(uReserves?.reserveA || 0n)
              : BigInt(sReserves?.reserveA || 0n);

          const liquidityValid = evaluateLiquidity({
            reserveBase: maxReserve,
            minTradeSize: 10n ** 16n,
            minTokenReserve: 10n ** token0.decimals,
            dexName: `${token0.symbol}/${token1.symbol}`
          }).valid;

          pairLiquidity[pairKey] =
            liquidityValid ? "OK" : "LOW";

        } catch (err) {
          console.warn(
            `Failed to update liquidity for ${token0.symbol}/${token1.symbol}:`,
            err.message
          );
        }
      }
    } finally {
      updatingLiquidity = false;
    }
  };

  setInterval(async () => {
    try {
      await updateLiquidity();
    } catch (err) {
      console.error("updateLiquidity error:", err);
    }
  }, 5000);

  // -----------------------------
  // 🖨️ OUTPUT
  // -----------------------------

  const oneSidedPairs = getDiscoveredPairs().filter(
    p => p.isOneSided
  );

  const bothPairs = getDiscoveredPairs().filter(
    p => p.isDirect
  );

  console.log("\n📊 PAIR VERIFICATION:\n");

  console.log(
    `🔥 ONE-SIDED PAIRS (${oneSidedPairs.length}):\n`
  );

  if (!oneSidedPairs.length) {
    console.log("   None found");
  } else {
    for (const p of oneSidedPairs) {
      console.log(
        `🔥 ${p.pairName} (${p.uniExists ? "Uniswap only" : "Sushi only"})`
      );
    }
  }

  console.log(
    `\n✅ BOTH-SIDED PAIRS (${bothPairs.length}):\n`
  );

  for (const p of bothPairs) {
    const pairKey = [p.token0.address, p.token1.address]
      .sort()
      .join("_");

    console.log(
      `✅ ${p.pairName} (Uniswap + Sushi) | Liquidity: ${pairLiquidity[pairKey]}`
    );
  }

  console.log(`\n🌉 STABLE BRIDGE COVERAGE:`);
  console.log(`🟢 FULL (USDC + DAI + USDT): ${bridgeFull}`);
  console.log(`🟡 PARTIAL (2/3): ${bridgePartial}`);
  console.log(`🟠 MINIMAL (1/3): ${bridgeMinimal}`);
  console.log(`⚪ NONE: ${bridgeNone}`);

  console.log("\n🧠 ROUTING SCORES:");

  const printedPairs = new Set();

  for (const p of getDiscoveredPairs()) {
    const pairKey = [
      p.token0.address,
      p.token1.address
    ]
      .sort()
      .join("_");

    if (printedPairs.has(pairKey)) continue;

    printedPairs.add(pairKey);

    console.log(
      `${p.pairName}: ${p.routingScore}/30 | Liquidity: ${
        pairLiquidity[pairKey] === "OK"
          ? "✅"
          : "⚠"
      }`
    );
  }

  startMonitoring();

  // ============================================================
  // 8️⃣ SHARED STATE + 9️⃣ SWAP EVENT WRAPPER
  // ============================================================

  const processedTxHashes = new Set();
  const skippedFirstEventPerPair = {};
  const lastTradePerPair = {};
  const lastExecutionTimePerPair = {};
  const isExecutingTradePerPair = {};

  const refs = {
    signer,
    lastSubmittedTxHash: null,
    goodTradesCounter: 0
  };

  const buildSwapCall = (
    exchange,
    event,
    token0,
    token1,
    savedRoutingScore
  ) =>
    swapEvent({
      exchange,
      event,
      token0,
      token1,
      routingScore: savedRoutingScore,
      monitoringProvider,
      topTokens,
      startBlock,
      processedTxHashes,
      skippedFirstEventPerPair,
      lastTradePerPair,
      lastExecutionTimePerPair,
      isExecutingTradePerPair,
      pauseMonitoring,
      resumeMonitoring,
      determineDirection,
      determineProfit,
      executeTrade,
      uFactory,
      sFactory,
      uRouter,
      sRouter,
      usdcToken,
      FLASH_LOAN_SIZE,
      networkType,
      executionProvider,
      refs,
      pairLiquidityMap: pairLiquidity,
      oneSidedPairsMap,
      reserveCache
    });

  // dynamic pair getter
  const getPairs = () => getDiscoveredPairs();

  // ============================================================
  // 🔟 EVENT MODE (POLLING OPTIMIZED / WEBSOCKET SAFE)
  // ============================================================
  if (isLocal || type === "FORK") {
    console.log("⚠️ Polling mode (local/fork)");

    setInterval(async () => {
      const currentBlock = await executionProvider.getBlockNumber();

      for (const pair of getPairs()) {
        const token0 = pair.token0;
        const token1 = pair.token1;
        const uPair = pair.uPair;
        const sPair = pair.sPair;

        // SAVE STABLE ROUTING SCORE
        const savedRoutingScore = BigInt(pair.routingScore);

        const pairKey = [token0.address, token1.address].sort().join("_");
        const lastBlock = lastProcessedBlockPerPair.get(pairKey) || (currentBlock - 10);

        // -----------------------------
        // Poll Uniswap logs
        if (uPair) {
          const logs = await uPair.queryFilter(
            uPair.filters.Swap(),
            lastBlock + 1,
            currentBlock
          );

          for (const log of logs) {
            await buildSwapCall(
              "Uniswap",
              log,
              token0,
              token1,
              savedRoutingScore
            );
          }
        }

        // -----------------------------
        // Poll Sushi logs
        if (sPair) {
          const logs = await sPair.queryFilter(
            sPair.filters.Swap(),
            lastBlock + 1,
            currentBlock
          );

          for (const log of logs) {
            await buildSwapCall(
              "Sushi",
              log,
              token0,
              token1,
              savedRoutingScore
            );
          }
        }

        lastProcessedBlockPerPair.set(pairKey, currentBlock);
      }
    }, 1000);

  } else {
    console.log("✅ WebSocket mode");

    for (const pair of getDiscoveredPairs()) {
      const token0 = pair.token0;
      const token1 = pair.token1;
      const uPair = pair.uPair;
      const sPair = pair.sPair;

      // SAVE STABLE ROUTING SCORE
      const savedRoutingScore = BigInt(pair.routingScore);

      if (uPair) {
        uPair.on(uPair.filters.Swap(), (...args) =>
          buildSwapCall(
            "Uniswap",
            args[args.length - 1],
            token0,
            token1,
            savedRoutingScore
          )
        );
      }

      if (sPair) {
        sPair.on(sPair.filters.Swap(), (...args) =>
          buildSwapCall(
            "Sushi",
            args[args.length - 1],
            token0,
            token1,
            savedRoutingScore
          )
        );
      }
    }
  }
}

// ─────────────────────────────────────────
// SWAP HANDLER (REFACTORED PROPERLY)
// ─────────────────────────────────────────
async function swapEvent(params) {
  const {
    exchange,
    event,
    token0,
    token1,
    routingScore,
    monitoringProvider,
    topTokens,
    startBlock,
    processedTxHashes,
    skippedFirstEventPerPair,
    lastTradePerPair,
    lastExecutionTimePerPair,
    isExecutingTradePerPair,
    pauseMonitoring,
    resumeMonitoring,
    determineDirection,
    determineProfit,
    executeTrade,
    uFactory,
    sFactory,
    uRouter,
    sRouter,
    usdcToken,
    FLASH_LOAN_SIZE,
    networkType,
    executionProvider,
    refs,
    pairLiquidityMap,
    oneSidedPairsMap,
    reserveCache
  } = params;

  // ============================================================
  // 🔹 INTERNAL QUEUE (SCOPED TO FUNCTION SYSTEM)
  // ============================================================

  if (!refs._swapQueue) refs._swapQueue = [];
  if (refs._isProcessingSwapQueue === undefined) refs._isProcessingSwapQueue = false;

  refs._swapQueue.push(params);

  // ============================================================
  // 🔹 QUEUE DRAINER (RUNS INLINE, NO OUTSIDE FUNCTIONS)
  // ============================================================

  if (refs._isProcessingSwapQueue) return;
  refs._isProcessingSwapQueue = true;

  const ORANGE = "\x1b[38;5;208m";
  const RESET = "\x1b[0m";

  try {
    while (refs._swapQueue.length > 0) {
      const p = refs._swapQueue.shift();
      if (!p) continue;

      let monitoringPaused = false;

      try {
        const {
          exchange,
          event,
          token0,
          token1,
          routingScore,
          monitoringProvider,
          topTokens,
          startBlock,
          processedTxHashes,
          skippedFirstEventPerPair,
          lastTradePerPair,
          lastExecutionTimePerPair,
          isExecutingTradePerPair,
          pauseMonitoring,
          resumeMonitoring,
          determineDirection,
          determineProfit,
          executeTrade,
          uFactory,
          sFactory,
          uRouter,
          sRouter,
          usdcToken,
          FLASH_LOAN_SIZE,
          networkType,
          executionProvider,
          refs,
          pairLiquidityMap,
          oneSidedPairsMap,
          reserveCache
        } = p;

        const txHash = event.log?.transactionHash || event.transactionHash;
        if (!txHash) continue;

        if (processedTxHashes.has(txHash)) continue;
        processedTxHashes.add(txHash);

        if (processedTxHashes.size > 50000) {
          const first = processedTxHashes.values().next().value;
          processedTxHashes.delete(first);
        }

        const blockNumber =
          event.log?.blockNumber ||
          event.blockNumber ||
          (await monitoringProvider.getBlockNumber());

        if (blockNumber <= startBlock) continue;

        // ============================================================
        // TOKEN DIRECTION
        // ============================================================

        let amountIn, rawInput, rawOutput;

        if (event.args.amount0In > 0n) {
          amountIn = event.args.amount0In;
          rawInput = token0;
          rawOutput = token1;
        } else if (event.args.amount1In > 0n) {
          amountIn = event.args.amount1In;
          rawInput = token1;
          rawOutput = token0;
        } else {
          continue;
        }

        const inputToken = topTokens.find(
          t => t.address.toLowerCase() === rawInput.address.toLowerCase()
        );

        const outputToken = topTokens.find(
          t => t.address.toLowerCase() === rawOutput.address.toLowerCase()
        );

        if (!inputToken || !outputToken) continue;

        const pairKey = [inputToken.address, outputToken.address].sort().join("_");

        // ============================================================
        // PER-PAIR LOCKS (UNCHANGED)
        // ============================================================

        if (!skippedFirstEventPerPair[pairKey]) {
          skippedFirstEventPerPair[pairKey] = true;
          continue;
        }

        if (isExecutingTradePerPair[pairKey]) continue;

        const now = Date.now();
        if (now - (lastExecutionTimePerPair[pairKey] || 0) < 3000) continue;

        if (lastTradePerPair[pairKey] === blockNumber) continue;

        const isWethPair =
          inputToken.symbol === "WETH" || outputToken.symbol === "WETH";

        if (!isWethPair) continue;

        // ============================================================
        // OUTPUT (UNCHANGED)
        // ============================================================

        pauseMonitoring();
        monitoringPaused = true;

        console.log(ORANGE + "═══════════════════════════════════════════════════════════" + RESET);
        console.log(`\n📢 Swap Event Detected: ${inputToken.symbol} → ${outputToken.symbol}`);
        console.log(`Event Amount In: ${amountIn.toString()}`);

        const MIN_ROUTING_SCORE = 20n;

        if (routingScore < MIN_ROUTING_SCORE) {
          console.log(`❌ Skipping due to routing score: ${routingScore}`);
          continue;
        }

        console.log(`✅ Using ${inputToken.symbol}/${outputToken.symbol} with routing score: ${routingScore}`);

        // ============================================================
        // RESERVES
        // ============================================================

        const cached = reserveCache.get(pairKey);
        if (!cached) continue;

        const uRes = cached.uReserves ?? null;
        const sRes = cached.sReserves ?? null;
        if (!uRes || !sRes) continue;

        const align = (res, inTok, outTok) => {
          const t0 = (res.token0 ?? "").toLowerCase();
          const t1 = (res.token1 ?? "").toLowerCase();

          const inA = inTok.address.toLowerCase();
          const outA = outTok.address.toLowerCase();

          const r0 = BigInt(res.reserve0 ?? 0n);
          const r1 = BigInt(res.reserve1 ?? 0n);

          if (inA === t0 && outA === t1) return { reserveIn: r0, reserveOut: r1 };
          if (inA === t1 && outA === t0) return { reserveIn: r1, reserveOut: r0 };

          return null;
        };

        const uni = align(uRes, inputToken, outputToken);
        const sushi = align(sRes, inputToken, outputToken);

        if (!uni && !sushi) continue;

        const uniIn = uni?.reserveIn ?? 0n;
        const sushiIn = sushi?.reserveIn ?? 0n;

        const reserveIn = uniIn < sushiIn ? uniIn : sushiIn;
        if (reserveIn <= 0n) continue;

        const SCALE = 1_000_000_000n;
        const impactScaled = (amountIn * SCALE) / reserveIn;
        const impactPct = Number(impactScaled) / 1e7;

        let signal = "NORMAL";
        if (impactScaled < 5_000n) signal = "LOW IMPACT";
        else if (impactScaled < 20_000n) signal = "GOOD ZONE";
        else if (impactScaled < 50_000n) signal = "HIGH IMPACT";
        else signal = "EXTREME IMPACT";

        console.log(`📊 Reserve Signal → Impact=${impactPct.toFixed(6)}% | Signal=${signal}`);
        console.log(`📊 IMPACT DEBUG → raw=${amountIn.toString()} reserve=${reserveIn.toString()} scaled=${impactScaled.toString()}`);
        console.log(ORANGE + "═══════════════════════════════════════════════════════════" + RESET);

        if (impactScaled < 2_000n) continue;
        if (impactScaled > 200_000_000n) continue;

        // ============================================================
        // EXECUTION
        // ============================================================

        isExecutingTradePerPair[pairKey] = true;

        try {
          const direction = await determineDirection(
            exchange,
            inputToken,
            outputToken,
            usdcToken,
            amountIn,
            uFactory,
            sFactory,
            uRouter,
            sRouter,
            monitoringProvider,
            topTokens,
            pairLiquidityMap,
            oneSidedPairsMap
          );

          if (!direction) continue;

          const avgWethPrice =
            (direction.uniWethPriceUSDC + direction.sushiWethPriceUSDC) / 2;

          const arbResult = await determineProfit({
            baseToken: direction.baseToken,
            targetToken: direction.targetToken,
            routerPath: direction.routerPath,
            routerNames: direction.routerNames,
            startingReserves: direction.startingReserves,
            endingReserves: direction.endingReserves,
            eventAmountIn: FLASH_LOAN_SIZE,
            networkType,
            wethPriceInUSDC: avgWethPrice,
            provider: executionProvider,
            uniWethPerTokenEnd: direction.uniWethPerTokenEnd,
            sushiWethPerTokenEnd: direction.sushiWethPerTokenEnd
          });

          if (!arbResult || arbResult.profit <= 0n) continue;

          const result = await executeTrade({
            startOnUniswap: direction.routerPath[0] === uRouter,
            baseToken: direction.baseToken,
            targetToken: direction.targetToken,
            amountBorrowed: arbResult.tradeAmount,
            signer: refs.signer
          });

          lastTradePerPair[pairKey] = blockNumber;
          lastExecutionTimePerPair[pairKey] = Date.now();

          if (result?.hash) refs.lastSubmittedTxHash = result.hash;
          if (result?.receipt?.status === 1n) refs.goodTradesCounter++;

        } finally {
          isExecutingTradePerPair[pairKey] = false;
        }

      } finally {
        refs.isGlobalExecuting = false;

        if (monitoringPaused && refs._swapQueue.length === 0) {
          resumeMonitoring();
        }
      }
    }

  } finally {
    refs._isProcessingSwapQueue = false;
  }
}

// ─────────────────────────────────────────────
// Determine Direction based on the Event Seen
// ─────────────────────────────────────────────
async function determineDirection(
  eventDex,
  inputToken,
  outputToken,
  usdcToken,
  eventAmountIn,
  uFactory,
  sFactory,
  uRouter,
  sRouter,
  provider,
  topTokens,
  pairLiquidityMap,
  oneSidedPairsMap,
  minWethReserve = 5n * 10n ** 18n,
  spreadThreshold = .2,
  snapshot = null,
  preFetchedReserves = null
) {
  try {
    const ORANGE = "\x1b[38;5;208m";
    const RESET = "\x1b[0m";
    const border = () => console.log(ORANGE + "═══════════════════════════════════════════════════════════" + RESET);

    border();
    console.log("🚀 Determine Direction (Flash Loan Base = WETH)");
    border();

    if (typeof eventAmountIn !== "bigint") eventAmountIn = BigInt(eventAmountIn.toString());
    const oneOutput = 10n ** BigInt(outputToken.decimals);

    console.log(`\n📢 Swap Event Detected: ${inputToken.symbol} → ${outputToken.symbol}`);
    console.log(`Event Amount In: ${ethers.formatUnits(eventAmountIn, Number(inputToken.decimals))}`);

    const baseToken = topTokens.find(t => t.symbol === "WETH");
    const targetToken = inputToken.symbol === "WETH" ? outputToken : inputToken;
    const bridgeToken = null;
    const useBridge = false;
    const fmt = (x, d = 6) => typeof x === "number" && isFinite(x) ? x.toFixed(d) : "NaN";
    const safePct = (a, b) => a && b ? ((b - a) / a) * 100 : 0;
 
    if (!baseToken || baseToken.symbol !== "WETH") {
      console.log("⚠️ No WETH in pair. Skipping.");
      return null;
    }

    // ------------------- RESERVES -------------------
    const uniPair = await getReserves(uFactory, baseToken, targetToken, provider);
    const sushiPair = await getReserves(sFactory, baseToken, targetToken, provider);

    if (!uniPair || !sushiPair) {
      console.log("❌ Missing pair data");
      return null;
    }

    // ------------------- KEEP YOUR VARIABLES -------------------
    const uReserveBase = BigInt(uniPair.reserveA);
    const uReserveTarget = BigInt(uniPair.reserveB);

    const sReserveBase = BigInt(sushiPair.reserveA);
    const sReserveTarget = BigInt(sushiPair.reserveB);

    // ------------------- ALSO BUILD STRUCTURED OUTPUT -------------------
    const startingReserves = {
      uBase: uReserveBase,
      uTarget: uReserveTarget,
      sBase: sReserveBase,
      sTarget: sReserveTarget
    };

    // ------------------- WETH → USDC PRICE (FIXED, ORDER SAFE) -------------------
    const uUsdcRes = await getReserves(uFactory, baseToken, usdcToken, provider);
    const sUsdcRes = await getReserves(sFactory, baseToken, usdcToken, provider);

    const getWethPriceInUSDC = (res) => {
      if (!res || res.reserveA === 0n || res.reserveB === 0n) return 0;

      const addrA = res.token0?.toLowerCase?.();
      const addrB = res.token1?.toLowerCase?.();

      const wethAddr = baseToken.address.toLowerCase();

      const wethIsA = addrA === wethAddr;

      const wethReserve = wethIsA ? res.reserve0 : res.reserve1;
      const usdcReserve = wethIsA ? res.reserve1 : res.reserve0;

      if (!wethReserve || !usdcReserve) return 0;

      return (
        Number(ethers.formatUnits(usdcReserve, usdcToken.decimals)) /
        Number(ethers.formatEther(wethReserve))
      );
    };

    const uniWethPriceUSDC = getWethPriceInUSDC(uUsdcRes);
    const sushiWethPriceUSDC = getWethPriceInUSDC(sUsdcRes);

    // ------------------- SIMULATE EVENT -------------------
    function simulateSwap(reserveIn, reserveOut, amountIn) {
      const amountInWithFee = (amountIn * 997n) / 1000n;
      const amountOut = (amountInWithFee * reserveOut) / (reserveIn + amountInWithFee);
      return { newReserveIn: reserveIn + amountIn, newReserveOut: reserveOut - amountOut };
    }

    let endingReserves = { ...startingReserves };
    const isBaseInput = inputToken.address.toLowerCase() === baseToken.address.toLowerCase();

    if (eventDex.toLowerCase() === "uniswap") {
      const swap = isBaseInput ? simulateSwap(uReserveBase, uReserveTarget, eventAmountIn) : simulateSwap(uReserveTarget, uReserveBase, eventAmountIn);
      endingReserves.uBase = isBaseInput ? swap.newReserveIn : swap.newReserveOut;
      endingReserves.uTarget = isBaseInput ? swap.newReserveOut : swap.newReserveIn;
    } else {
      const swap = isBaseInput ? simulateSwap(sReserveBase, sReserveTarget, eventAmountIn) : simulateSwap(sReserveTarget, sReserveBase, eventAmountIn);
      endingReserves.sBase = isBaseInput ? swap.newReserveIn : swap.newReserveOut;
      endingReserves.sTarget = isBaseInput ? swap.newReserveOut : swap.newReserveIn;
    }

    // ------------------- PRICE CALC ------------------- 
    const SCALED = 10n ** BigInt(targetToken.decimals);

    const uniWethPerTokenStart = startingReserves.uTarget > 0n ? (startingReserves.uBase * SCALED) / startingReserves.uTarget: 0n;
    const sushiWethPerTokenStart = startingReserves.sTarget > 0n ? (startingReserves.sBase * SCALED) / startingReserves.sTarget : 0n;
    const uniWethPerTokenEnd = endingReserves.uTarget > 0n ? (endingReserves.uBase * SCALED) / endingReserves.uTarget : 0n;
    const sushiWethPerTokenEnd = endingReserves.sTarget > 0n ? (endingReserves.sBase * SCALED) / endingReserves.sTarget : 0n;

    const uniUsdcPerTokenStart = uniWethPriceUSDC ? Number(ethers.formatUnits(uniWethPerTokenStart, targetToken.decimals)) * uniWethPriceUSDC : NaN;
    const sushiUsdcPerTokenStart = sushiWethPriceUSDC ? Number(ethers.formatUnits(sushiWethPerTokenStart, targetToken.decimals)) * sushiWethPriceUSDC : NaN;
    const uniUsdcPerTokenEnd = uniWethPriceUSDC ? Number(ethers.formatUnits(uniWethPerTokenEnd, targetToken.decimals)) * uniWethPriceUSDC: NaN;
    const sushiUsdcPerTokenEnd = sushiWethPriceUSDC ? Number(ethers.formatUnits(sushiWethPerTokenEnd, targetToken.decimals)) * sushiWethPriceUSDC : NaN;

    // ------------------- EXECUTION FEASIBILITY CHECK -------------------

    // Per-DEX WETH liquidity (correct model)
    const uniWethLiquidity = endingReserves.uBase;
    const sushiWethLiquidity = endingReserves.sBase;

    // Per-DEX max executable (25% of each pool)
    const uniMaxExecutable = uniWethLiquidity / 4n;
    const sushiMaxExecutable = sushiWethLiquidity / 4n;

    // Choose relevant DEX based on where the event is happening
    const isUniswap = eventDex.toLowerCase() === "uniswap";

    const maxExecutableTrade = isUniswap
      ? uniMaxExecutable
      : sushiMaxExecutable;

    console.log(`💧 Uniswap WETH Liquidity: ${ethers.formatEther(uniWethLiquidity)}`);
    console.log(`💧 Sushi WETH Liquidity: ${ethers.formatEther(sushiWethLiquidity)}`);

    console.log(`💧 Selected Max Executable: ${ethers.formatEther(maxExecutableTrade)} WETH`);

    const MIN_TRADE = 10n ** 15n; // ~0.001 WETH
    if (maxExecutableTrade < MIN_TRADE) {
      console.log(`❌ Skipping: maxExecutableTrade < MIN_TRADE | max=${maxExecutableTrade.toString()}`);
      return null;
    }

    // Debug
    console.log("\n🔍 EXECUTION CHECK");
    console.log("eventDex:", eventDex);
    console.log("eventAmountIn:", ethers.formatEther(eventAmountIn));
    console.log("maxExecutableTrade:", ethers.formatEther(maxExecutableTrade));

    // HARD FILTER ONLY
    if (eventAmountIn > maxExecutableTrade || maxExecutableTrade <= 0n) {
      console.log(
        `❌ Skipping: insufficient executable liquidity ` +
        `| event=${eventAmountIn.toString()} ` +
        `| max=${maxExecutableTrade.toString()}`
      );
      return null;
    }

    // ------------------- SPREAD & LIQUIDITY -------------------

    const buyPrice =
      uniWethPerTokenEnd < sushiWethPerTokenEnd
        ? uniWethPerTokenEnd
        : sushiWethPerTokenEnd;

    const sellPrice =
      uniWethPerTokenEnd > sushiWethPerTokenEnd
        ? uniWethPerTokenEnd
        : sushiWethPerTokenEnd;

    // True arbitrage spread
    const spreadBps =
      buyPrice > 0n ? ((sellPrice - buyPrice) * 10_000n) / buyPrice : 0n;

    const pctWeth = Number(spreadBps) / 100;

    const signedSpread =
      uniWethPerTokenEnd > sushiWethPerTokenEnd ? pctWeth : -pctWeth;

    // ONLY liquidity status (no recalculating execution logic)
    const uniLiquidity = evaluateLiquidity({
      reserveBase: endingReserves.uBase,
      minWethReserve,
      dexName: "Uniswap"
    });

    const sushiLiquidity = evaluateLiquidity({
      reserveBase: endingReserves.sBase,
      minWethReserve,
      dexName: "Sushi"
    });

    // FINAL COMBINED CHECK (pure decision layer)
    const liquidityPassed = uniLiquidity.valid && sushiLiquidity.valid;
    const spreadPassed = Math.abs(pctWeth) >= Number(spreadThreshold);
    const crossDexSpread = pctWeth;
    const uniWethReserve = getWethReserve(uniPair, baseToken.address);
    const sushiWethReserve = getWethReserve(sushiPair, baseToken.address);

    // ------------------- LOGGING -------------------

    const scale = targetToken.decimals;

    const fmtPrice = (x, decimals = 18, display = 18) => {
    if (!x || x === 0n) return "0";

      return parseFloat(ethers.formatUnits(x, decimals)).toFixed(display);
    };

    const pctChange = (a, b, decimals = 18) => {
      if (a <= 0n) return "0.00";

      const aNum = parseFloat(ethers.formatUnits(a, decimals));
      const bNum = parseFloat(ethers.formatUnits(b, decimals));

      return (((bNum - aNum) / aNum) * 100).toFixed(2);
    };

    const logDexPrices = (dex, wethStart, wethEnd,usdStart, usdEnd) => {
      console.log(`\n${dex}:`);

      console.log(`  BEFORE → ${fmtPrice(wethStart, targetToken.decimals, 18)} WETH ` + `| ${fmt(usdStart)} USD`);

      console.log(
        `  AFTER  → ${fmtPrice(wethEnd, targetToken.decimals, 18)} WETH ` +
        `(${pctChange(wethStart, wethEnd, targetToken.decimals)}%) ` +
        `| ${fmt(usdEnd)} USD ` +
        `(${fmt(((usdEnd - usdStart) / (usdStart || 1)) * 100, 2)}%)`
      );
    };

    console.log("\n💸 Price Impact Summary");

    logDexPrices("Uniswap", uniWethPerTokenStart, uniWethPerTokenEnd, uniUsdcPerTokenStart, uniUsdcPerTokenEnd);
    logDexPrices("Sushi", sushiWethPerTokenStart, sushiWethPerTokenEnd, sushiUsdcPerTokenStart, sushiUsdcPerTokenEnd);

    console.log(`\n🔺 Direct Arb Spread: ${crossDexSpread.toFixed(2)}%`);

    console.log("\n📈 Reserves");
    console.log(`Uniswap WETH Reserve: ${ethers.formatEther(uniWethReserve)}`);
    console.log(`Sushi WETH Reserve: ${ethers.formatEther(sushiWethReserve)}`);

    console.log(`\n💧 Liquidity Status: ${liquidityPassed ? "Passed ✅" : "Failed ❌"}`);
    if (!liquidityPassed) {
      console.log("❌ Liquidity failure breakdown:");
      console.log("  Uniswap valid:", uniLiquidity.valid);
      console.log("  Sushi valid:", sushiLiquidity.valid);
      console.log("  Execution OK:", executionLiquidityPassed);
    }
    console.log(`📊 Spread Status: ${spreadPassed ? "Passed ✅" : `Failed ❌ (${pctWeth.toFixed(2)}%)`}`);
    console.log(`📊 Cross-DEX Spread: ${crossDexSpread.toFixed(2)}%`);
    border();

    if (!liquidityPassed || !spreadPassed) return null;

    // ------------------- TRADE PATH -------------------
    const routerPath = uniWethPerTokenEnd > sushiWethPerTokenEnd ? [sRouter, uRouter] : [uRouter, sRouter];
    const routerNames = uniWethPerTokenEnd > sushiWethPerTokenEnd ? ["Sushi", "Uniswap"] : ["Uniswap", "Sushi"];
    const tradePath = [
      { inToken: baseToken, outToken: targetToken, router: routerPath[0] },
      { inToken: targetToken, outToken: baseToken, router: routerPath[1] }
    ];

    console.log("\n💸 Arbitrage Trade Path:");
    console.log(`${baseToken.symbol} → ${targetToken.symbol} → ${baseToken.symbol}`);
    console.log(`Execution Routers: ${routerNames.join(" → ")}`);
    border();

    return {
      baseToken,
      targetToken,
      bridgeToken: null,
      routerPath,
      routerNames,
      priceDifferencePct: pctWeth,
      startingReserves,
      endingReserves,
      uniWethPerTokenStart,
      uniWethPerTokenEnd,
      sushiWethPerTokenStart,
      sushiWethPerTokenEnd,
      uniUsdcPerTokenStart,
      uniUsdcPerTokenEnd,
      sushiUsdcPerTokenStart,
      sushiUsdcPerTokenEnd,
      uniWethPriceUSDC,
      sushiWethPriceUSDC,
      liquidityPassed,
      spreadPassed,
      tradePath
    };

  } catch (err) {
    console.error("Error determining direction:", err);
    return null;
  }
}

// ─────────────────────────────────────────────
// Determine profit including percentage and DEX differences
// ─────────────────────────────────────────────
async function determineProfit({
  baseToken,
  targetToken,
  bridgeToken,
  routerPath,               // array of Contract objects
  routerNames,              // array of string names
  tradePath,                // array of { inToken, outToken }
  endingReserves,
  networkType,
  wethPriceInUSDC,
  provider,
  uniWethPerTokenEnd,       // from determineDirection
  sushiWethPerTokenEnd,     // from determineDirection
  maxSlippagePercent = 1n,  // 1% max % of pool allowed to trade
  gasUsed = 150_000n,       // default gas units for estimation
  gasPrice = 0n             // in wei
}) {
  try {
    const chalk = require("chalk");
    const orange = chalk.rgb(255, 140, 0);

    console.log(orange("════════════════════════════════════════════"));
    console.log("🚀 Determine Profit (2 Token Arbitrage)");
    console.log(orange("════════════════════════════════════════════"));
    console.log("Base:", baseToken.symbol);
    console.log("Target:", targetToken.symbol, "\n");

    const wethPrice = Number(wethPriceInUSDC ?? 0);
    console.log("WETH Price (USDC):", wethPrice, "\n");

    // ------------------ Ensure tradePath exists ------------------
    if (!tradePath || !Array.isArray(tradePath) || tradePath.length === 0) {
      tradePath = [{ inToken: baseToken, outToken: targetToken }];
    }

    // ------------------ Ensure routerPath exists ------------------
    if (!routerPath || !Array.isArray(routerPath) || routerPath.length === 0) {
      throw new Error(`Invalid routerPath: ${JSON.stringify(routerNames)}`);
    }

    // ------------------ GET RESERVES (TRUST DIRECTION OUTPUT) ------------------

    const getReserveSet = (dex) => {
      if (dex === "Uniswap") {
        return {
          in: endingReserves.uBase,
          out: endingReserves.uTarget
        };
      }

      if (dex === "Sushi") {
        return {
          in: endingReserves.sBase,
          out: endingReserves.sTarget
        };
      }

      throw new Error(`Unknown DEX: ${dex}`);
    };

    // 2-token or 3-token doesn't matter anymore
    const buy = getReserveSet(routerNames[0]);
    const sell = getReserveSet(routerNames[routerNames.length - 1]);

    buyReserveIn   = buy.in;
    buyReserveOut  = buy.out;

    sellReserveIn  = sell.in;
    sellReserveOut = sell.out;

    // ------------------ Max Flash Loan ------------------
    const flashLoanMax = getFlashLoanSize(networkType);
    console.log(
      "Flash Loan Max:",
      ethers.formatUnits(flashLoanMax, baseToken.decimals),
      baseToken.symbol
    );

    // ------------------ Optimal Trade ------------------
    const maxImpactTrade = (buyReserveIn * maxSlippagePercent) / 100n;
    const cappedMaxTrade = flashLoanMax < maxImpactTrade ? flashLoanMax : maxImpactTrade;

    const { tradeSize, profit } = calculateOptimalArbitrageTrade({
      buyReserveIn,
      buyReserveOut,
      sellReserveIn,
      sellReserveOut,
      maxTrade: cappedMaxTrade,
      maxImpactPercent: maxSlippagePercent
    });

    // ------------------ Slippage-Limited Max Trade ------------------
    const maxTradeAllowed = tradeSize <= maxImpactTrade ? tradeSize : maxImpactTrade;

    console.log("Max Trade Allowed (Slippage Cap):", ethers.formatUnits(maxTradeAllowed, baseToken.decimals), baseToken.symbol);
    console.log("Flash Loan Used:", ethers.formatUnits(maxTradeAllowed, baseToken.decimals), baseToken.symbol, "\n" );

    if (tradeSize <= 0n || profit <= 0n) {
      console.log("No arbitrage opportunity or profit is 0.");
      console.log(orange("════════════════════════════════════════════"));
      return { profitable: false, tradeAmount: 0n, profit: 0n };
    }

    // ------------------ Estimate Net Profit ------------------
    const estimate = await estimateMaxProfit({
      buyReserveIn,
      buyReserveOut,
      sellReserveIn,
      sellReserveOut,
      tradeSize: tradeSize,
      gasUsed,
      gasPrice
    });

    if (!estimate) {
      console.log("Could not estimate profit.");
      return { profitable: false, tradeAmount: 0n, profit: 0n };
    }

    // ------------------ PROFIT CAP ($10 min) ------------------
    const MAX_PROFIT_USD = 10;

    // convert WETH profit → USD
    const profitInWeth = Number(ethers.formatUnits(estimate.profit, 18));
    const profitInUsd = profitInWeth * wethPrice;

    const isAboveMinProfit = profitInUsd >= MAX_PROFIT_USD;

    const slippageBps = 50n; // define early
    const wethProfit = profitInWeth;
    const profitUSDC = wethProfit * wethPrice;
    const roiPercent =
      maxTradeAllowed > 0n
        ? (wethProfit / Number(ethers.formatUnits(maxTradeAllowed, 18))) * 100
        : 0;

    // ❌ EARLY EXIT (correct)
    if (!isAboveMinProfit) {
      console.log("Arbitrage Profitable: NO ❌ (below $10 threshold)");

      return {
        profitable: false,
        tradeAmount: 0n,
        profitWETH: estimate.profit,
        profitUSDC,
        slippageBps
      };
    }

    // ------------------ Compute Buy/Sell Prices ------------------
    const buyPriceRaw  =
      routerNames[0] === "Uniswap" ? uniWethPerTokenEnd : sushiWethPerTokenEnd;

    const sellPriceRaw =
      routerNames[1] === "Uniswap" ? uniWethPerTokenEnd : sushiWethPerTokenEnd;

    const buyPrice = Number(ethers.formatUnits(buyPriceRaw, 18));
    const sellPrice = Number(ethers.formatUnits(sellPriceRaw, 18));

    // ------------------ Display ------------------
    console.log(`Buy Price  (${routerNames[0]}):`, buyPrice.toFixed(9), baseToken.symbol);
    console.log(`Sell Price (${routerNames[1]}):`, sellPrice.toFixed(9), baseToken.symbol, "\n");

    console.log("Profit (WETH):", ethers.formatUnits(estimate.profit, baseToken.decimals));
    console.log("Profit (USDC):", profitUSDC.toFixed(6));
    console.log("ROI:", roiPercent.toFixed(2) + "%");

    console.log(orange("════════════════════════════════════════════"));
    console.log("Arbitrage Profitable:", "YES ✅");
    console.log(orange("════════════════════════════════════════════"));

    return {
      profitable: true,
      tradeAmount: tradeSize,
      profitWETH: estimate.profit,
      profitUSDC,
      slippageBps
    };

  } catch (err) {
    console.error("determineProfit error:", err);
    return { profitable: false, tradeAmount: 0n, profit: 0n };
  }
}

// ─────────────────────────────────────────
// EXECUTE TRADE (2-TOKEN OR TRIANGULAR)
// ─────────────────────────────────────────
async function executeTrade({
  startOnUniswap,
  baseToken,
  targetToken,
  amountBorrowed,
  signer
}) {
  if (!signer) {
    throw new Error("Signer is required");
  }

  const arb = arbitrage.connect(signer);

  try {
    // ---------------- ORANGE BORDER ----------------
    const now = new Date();
    const timestamp = now.toLocaleString("en-US", { hour12: true });

    console.log(orange("═══════════════════════════════════════════════════════════"));
    console.log(orange("🚀 Executing Trade (Flash Loan Arbitrage)"));
    console.log(orange("═══════════════════════════════════════════════════════════"));

    console.log(`🕒 Timestamp: ${timestamp}`);
    console.log("🚀 Executing Arbitrage Trade");
    console.log(`Borrowing Amount: ${ethers.formatUnits(amountBorrowed, baseToken.decimals)} ${baseToken.symbol}`);
    console.log(`Start On Uniswap: ${startOnUniswap}`);

    if (PROJECT_SETTINGS.SIMULATE_TRADES) {
      if (PROJECT_SETTINGS.isLocal) {
        // Simulate on local/forked network (perform all steps as if it's a real trade)
        console.log("⚠️ Simulating trade on local network... Performing all steps as if it were real.");
        // Simulate the trade here
        console.log("🧱 Block number (simulation): 24548821"); // Example block number
        console.log("✅ Simulated trade completed on local network.");
        console.log(orange("═══════════════════════════════════════════════════════════"));
        return {
          hash: null, // No transaction hash in simulation
          receipt: null // No receipt in simulation
        };
      } else {
        // Simulate on live network (do not broadcast)
        console.log("⚠️ Simulating trade... No real transaction will be sent.");
        console.log("✅ Simulated trade completed on live network.");
        console.log(orange("═══════════════════════════════════════════════════════════"));
        return {
          hash: null, // No transaction hash
          receipt: null // No receipt
        };
      }
    }

    // If not in simulation mode, execute the real trade
    const tx = await arb.executeTrade(
      startOnUniswap,
      baseToken.address,
      targetToken.address,
      ethers.ZeroAddress,
      amountBorrowed, 
      slippageBps
    );

    console.log(`📨 Transaction sent: ${tx.hash}`);

    // Wait for receipt (real trade)
    const receipt = await tx.wait();

    if (receipt.status !== 1) {
      throw new Error("Transaction reverted on-chain");
    }

    console.log(`✅ Trade mined in block: ${receipt.blockNumber}`);
    console.log(orange("═══════════════════════════════════════════════════════════\n"));

    return {
      hash: tx.hash,
      receipt
    };
  } catch (err) {
    console.error(orange("❌ Trade execution failed:"), err);
    throw err;
  }
}

// ─────────────────────────────────────────
// START
// ─────────────────────────────────────────
main().catch(console.error);

// Works !! Got Main and swapEvent seperate. All functions seems to work good!!!! working on new thing?
