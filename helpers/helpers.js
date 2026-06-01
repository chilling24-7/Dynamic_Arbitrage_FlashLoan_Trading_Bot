const { ethers } = require("ethers");
const { formatUnits } = require("ethers");
const IUniswapV2Pair = require("@uniswap/v2-core/build/IUniswapV2Pair.json");
const chalk = require("chalk");

const orange = chalk.rgb(255, 140, 0);

// ----------------- State -----------------
const token0Cache = new Map();
let lastMempoolEvent;

// ----------------- Network Detection -----------------
async function determineNetwork(provider, poolKey = null, isLocal) {
  const network = await provider.getNetwork();
  const chainId = BigInt(network.chainId);

  let type = "OTHER";
  let vaultAddress = "0xBA12222222228d8Ba445958a75a0704d566BF2C8";
  let poolId = poolKey ?? null;
  let supportsWebSocket = false;

  if (isLocal) type = "FORK";
  else {
    switch (chainId) {
      case 1n: type = "MAINNET"; supportsWebSocket = true; break;
      case 5n:
      case 11155111n: type = "TESTNET"; supportsWebSocket = true; break;
      case 43114n: type = "AVALANCHE"; supportsWebSocket = true; break;
      case 43113n: type = "AVALANCHE_FUJI"; supportsWebSocket = true; break;
      case 73799n: type = "AVEE"; supportsWebSocket = true; break;
    }
  }

  const startBlock = await provider.getBlockNumber();
  console.log(orange("════════════════════════════════════════════════"));
  console.log(`🕒 Timestamp: ${new Date().toLocaleString()}`);
  console.log("🌐 Network type:", type);
  console.log("🏦 Vault address:", vaultAddress);
  console.log("🪙 Pool ID:", poolId);
  console.log("🧱 Start block:", startBlock);
  console.log(orange("════════════════════════════════════════════════"));

  return { type, vaultAddress, poolId, startBlock, supportsWebSocket };
}

// ----------------- Signer -----------------
async function getSigner(type, provider) {
  if (type === "LOCAL") {
    const accounts = await provider.listAccounts();
    return provider.getSigner(accounts[0]);
  }
  return new ethers.Wallet(process.env.PRIVATE_KEY, provider);
}

// ----------------- Pair Contract -----------------
async function getOrCreatePairContract(factory, tokenA, tokenB, provider) {
  if (!factory) return null;
  const pairAddress = await factory.getPair(tokenA, tokenB);
  if (!pairAddress || pairAddress === ethers.ZeroAddress) return null;
  return new ethers.Contract(pairAddress, IUniswapV2Pair.abi, provider);
}

// ----------------- Safe Transaction Fetch -----------------
async function safeGetTransaction(provider, hash, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await provider.getTransaction(hash);
    } catch (err) {
      if (err.code === 429) await new Promise(res => setTimeout(res, 100 * (i + 1)));
      else throw err;
    }
  }
  return null;
}

// ----------------- Provider Reset -----------------
async function resetProvider({ oldProvider, alchemyKey, setupMempool, pairs, swapHandler }) {
  try { oldProvider?._websocket?.terminate(); oldProvider?.removeAllListeners?.(); } catch {}
  const newProvider = new ethers.WebSocketProvider(`wss://eth-mainnet.g.alchemy.com/v2/${alchemyKey}`);

  newProvider._websocket?.on("open", () => console.log("🟢 WS connected"));
  newProvider._websocket?.on("close", (code) => console.log("🔴 WS closed:", code));
  newProvider._websocket?.on("error", (err) => console.error("WS error:", err));
  newProvider.on("error", (err) => console.error("Provider error:", err));

  if (setupMempool) {
    await setupMempool(newProvider, pairs, swapHandler);
    lastMempoolEvent = Date.now();
  }

  return newProvider;
}

function sqrtBigInt(value) {
  if (value < 0n) throw new Error("sqrtBigInt: negative input");
  if (value < 2n) return value;

  let x0 = value;
  let x1 = (x0 + value / x0) >> 1n;

  while (x1 < x0) {
    x0 = x1;
    x1 = (x0 + value / x0) >> 1n;
  }

  return x0;
}

// ----------------- Get Reserves -----------------
async function getReserves(factory, tokenA, tokenB, provider) {
  if (!factory || !provider || !tokenA?.address || !tokenB?.address) return null;

  const addrA = tokenA.address.toLowerCase();
  const addrB = tokenB.address.toLowerCase();
  if (addrA === addrB) return null;

  const pairAddress = await factory.getPair(addrA, addrB);
  if (!pairAddress || pairAddress === ethers.ZeroAddress) return null;

  const pair = new ethers.Contract(pairAddress, IUniswapV2Pair.abi, provider);

  const reserves = await pair.getReserves();
  if (!reserves) return null;

  const r0 = BigInt(reserves[0]);
  const r1 = BigInt(reserves[1]);

  let token0;
  if (token0Cache.has(pairAddress)) {
    token0 = token0Cache.get(pairAddress);
  } else {
    token0 = (await pair.token0()).toLowerCase();
    token0Cache.set(pairAddress, token0);
  }

  const reserveA = token0 === addrA ? r0 : r1;
  const reserveB = token0 === addrA ? r1 : r0;

  // ============================================================
  // 🔥 ADDITIONS (DO NOT BREAK ORIGINAL OUTPUT)
  // ============================================================

  // -----------------------------
  // 1. Spot Prices
  // -----------------------------
  const priceAtoB =
    reserveA > 0n ? Number(reserveB * 10n ** 18n / reserveA) : 0;

  const priceBtoA =
    reserveB > 0n ? Number(reserveA * 10n ** 18n / reserveB) : 0;

  // -----------------------------
  // 2. Liquidity shape (geometric mean)
  // -----------------------------
  const geometricLiquidity =
    reserveA < reserveB
      ? sqrtBigInt(reserveA * reserveB)
      : sqrtBigInt(reserveA * reserveB);

  // -----------------------------
  // 3. Imbalance ratio
  // -----------------------------
  const imbalanceRatio =
    reserveA > reserveB
      ? (reserveA * 100n) / reserveB
      : (reserveB * 100n) / reserveA;

  // -----------------------------
  // 4. Quick swap simulation helper (cheap approx)
  // -----------------------------
  const simulateSwap = (amountIn, reserveIn, reserveOut) => {
    if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;

    const amountInWithFee = amountIn * 997n;

    return (
      amountInWithFee * reserveOut
    ) / (
      reserveIn * 1000n + amountInWithFee
    );
  };

  // -----------------------------
  // 5. Precompute flash loan impact (if available globally)
  // -----------------------------
  const FLASH_IMPACT =
    typeof FLASH_LOAN_SIZE !== "undefined"
      ? FLASH_LOAN_SIZE
      : 0n;

  let priceImpactBps = 0n;

  if (FLASH_IMPACT > 0n && reserveA > 0n && reserveB > 0n) {
    const out = simulateSwap(FLASH_IMPACT, reserveA, reserveB);

    const idealOut = (FLASH_IMPACT * reserveB) / reserveA;

    priceImpactBps =
      idealOut > 0n
        ? ((idealOut - out) * 10000n) / idealOut
        : 0n;
  }

  // -----------------------------
  // 6. Reserve quality score (cheap filter signal)
  // -----------------------------
  let qualityScore = 0;

  if (reserveA > 0n && reserveB > 0n) {
    if (geometricLiquidity > 10n ** 20n) qualityScore += 2;
    if (imbalanceRatio < 500n) qualityScore += 2;
    if (priceImpactBps < 300n) qualityScore += 2;
  }

  // ============================================================
  // ORIGINAL OUTPUT (UNCHANGED)
  // ============================================================
  return {
    pairAddress,
    token0,
    token1: token0 === addrA ? addrB : addrA,
    reserve0: r0,
    reserve1: r1,
    reserveA,
    reserveB,

    getDirectionalReserves: (from, to) => {
      const f = from.toLowerCase();
      const t = to.toLowerCase();
      if (f === addrA && t === addrB) return { reserveIn: r0, reserveOut: r1 };
      if (f === addrB && t === addrA) return { reserveIn: r1, reserveOut: r0 };
      return null;
    },

    // ============================================================
    // 🔥 NEW ATTACHED SIGNALS (SAFE ADDITIONS)
    // ============================================================

    priceAtoB,
    priceBtoA,

    geometricLiquidity,
    imbalanceRatio,

    priceImpactBps,
    qualityScore
  };
}

function getWethReserve(pair, wethAddress) {
  const weth = wethAddress.toLowerCase();

  if (pair.token0.toLowerCase() === weth) return pair.reserve0;
  if (pair.token1.toLowerCase() === weth) return pair.reserve1;

  return 0n;
}

// ----------------- Evaluate Liquidity -----------------
function evaluateLiquidity({
  uReserves = null,
  sReserves = null,
  flashLoanSize = 0n,
  maxSlippagePercent = 3n,
  minPoolValue = 0n // 🔥 NEW: optional soft filter baseline
}) {

  // -------------------------
  // SAFE normalize (prevents crashes)
  // -------------------------
  const normalize = (r) => {
    const r0 = BigInt(r?.reserve0 ?? 0n);
    const r1 = BigInt(r?.reserve1 ?? 0n);
    return {
      reserve0: r0,
      reserve1: r1
    };
  };

  const u = normalize(uReserves);
  const s = normalize(sReserves);

  // -------------------------
  // SAFE slippage estimate
  // -------------------------
  const estimateSlippage = (amountIn, reserveIn) => {
    if (!reserveIn || reserveIn <= 0n) return 0;
    return Number((amountIn * 10000n) / reserveIn) / 100;
  };

  // -------------------------
  // SAFE side evaluation
  // -------------------------
  const calcSide = (reserve) => {
    if (!reserve || reserve <= 0n) {
      return {
        reserve: 0n,
        safeTrade: 0n,
        slippage: 0
      };
    }

    const safeTrade =
      (reserve * maxSlippagePercent * 100n) / 10000n;

    return {
      reserve,
      safeTrade,
      slippage: estimateSlippage(safeTrade, reserve)
    };
  };

  // -------------------------
  // DEX evaluation
  // -------------------------
  const uni0 = calcSide(u.reserve0);
  const uni1 = calcSide(u.reserve1);
  const sushi0 = calcSide(s.reserve0);
  const sushi1 = calcSide(s.reserve1);

  const uniEffective = uni0.safeTrade < uni1.safeTrade ? uni0.safeTrade : uni1.safeTrade;
  const sushiEffective = sushi0.safeTrade < sushi1.safeTrade ? sushi0.safeTrade : sushi1.safeTrade;

  const sharedLiquidity =
    uniEffective < sushiEffective ? uniEffective : sushiEffective;

  const recommendedFlashLoan = sharedLiquidity;

  // -------------------------
  // WORST SLIPPAGE
  // -------------------------
  const worstSlippage = Math.max(
    uni0.slippage,
    uni1.slippage,
    sushi0.slippage,
    sushi1.slippage
  );

  // -------------------------
  // PRESSURE (safe)
  // -------------------------
  const calcPressure = (safeTrade, reserve) => {
    if (!reserve || reserve <= 0n || !safeTrade) return 0;
    return Number((safeTrade * 10000n) / reserve) / 100;
  };

  const uniPressure = Math.max(
    calcPressure(uni0.safeTrade, uni0.reserve),
    calcPressure(uni1.safeTrade, uni1.reserve)
  );

  const sushiPressure = Math.max(
    calcPressure(sushi0.safeTrade, sushi0.reserve),
    calcPressure(sushi1.safeTrade, sushi1.reserve)
  );

  const pressureOk = uniPressure < 40 && sushiPressure < 40;

  // -------------------------
  // HARD VALIDITY (unchanged logic)
  // -------------------------
  const uniValid = uniEffective >= flashLoanSize;
  const sushiValid = sushiEffective >= flashLoanSize;

  const hardValid = uniValid && sushiValid;

  // -------------------------
  // SOFT SIGNALS
  // -------------------------
  const uniBufferedOk = uniEffective >= flashLoanSize * 2n;
  const sushiBufferedOk = sushiEffective >= flashLoanSize * 2n;

  const imbalanceOk =
    uniEffective === 0n || sushiEffective === 0n
      ? false
      : uniEffective * 10n >= sushiEffective &&
        sushiEffective * 10n >= uniEffective;

  const slippageOk = worstSlippage <= 2.5;

  const softScore =
    (uniBufferedOk ? 1 : 0) +
    (sushiBufferedOk ? 1 : 0) +
    (pressureOk ? 1 : 0) +
    (imbalanceOk ? 1 : 0) +
    (slippageOk ? 1 : 0);

  // -------------------------
  // LIQUIDITY VALUE SCORE (🔥 NEW BALANCED ADDITION)
  // -------------------------
  const poolValue = sharedLiquidity;

  const valueScore =
    minPoolValue === 0n
      ? 5 // no filter mode = neutral boost
      : poolValue >= minPoolValue * 5n ? 10 :
        poolValue >= minPoolValue * 2n ? 7 :
        poolValue >= minPoolValue ? 5 :
        poolValue > 0n ? 2 : 0;

  const liquidityScore =
    softScore * 4 + valueScore; // 0–30-ish range

  // -------------------------
  // FINAL VALIDITY (still balanced)
  // -------------------------
  const valid =
    hardValid &&
    softScore >= 2;

  // -------------------------
  // CLASSIFICATION (NO MORE HARD GATING)
  // -------------------------
  let liquidityLevel = "LOW";

  if (valid) {
    if (
      liquidityScore >= 22 &&
      worstSlippage <= 1
    ) {
      liquidityLevel = "HIGH";
    } else {
      liquidityLevel = "OK";
    }
  }

  // -------------------------
  // OUTPUT (UNCHANGED SHAPE + ADD SCORE)
  // -------------------------
  return {
    valid,
    liquidityLevel,

    sharedLiquidity,
    recommendedFlashLoan,
    worstSlippage,

    liquidityScore, // 🔥 NEW (important for routing)

    uni: {
      reserve0: u.reserve0,
      reserve1: u.reserve1,
      safeTrade: uniEffective,
      slippage: Math.max(uni0.slippage, uni1.slippage),
      valid: uniValid
    },

    sushi: {
      reserve0: s.reserve0,
      reserve1: s.reserve1,
      safeTrade: sushiEffective,
      slippage: Math.max(sushi0.slippage, sushi1.slippage),
      valid: sushiValid
    }
  };
}

// ----------------- Get Flash Loan Size -----------------
function getFlashLoanSize(type) {
  if (type === "LOCAL") return ethers.parseUnits("10", 18);
  if (type === "FORK") return ethers.parseUnits("1", 18);
  return ethers.parseUnits("10", 18);
}

// ----------------- Calculate Optimal Arbitrage Trade -----------------
// ============================================================
// 🧠 Uniswap V2 swap simulation (SOURCE OF TRUTH)
// ============================================================
const FEE_NUM = 997n;
const FEE_DEN = 1000n;

function simulateSwap(amountIn, reserveIn, reserveOut) {
  const FEE_NUM = 997n;
  const FEE_DEN = 1000n;

  if (amountIn <= 0n) return 0n;
  if (reserveIn <= 0n || reserveOut <= 0n) return 0n;

  const amountInWithFee = amountIn * FEE_NUM;

  return (amountInWithFee * reserveOut) /
         (reserveIn * FEE_DEN + amountInWithFee);
}

// ----------------- Estimate Max Profit -----------------
async function estimateMaxProfit({
  buyReserveIn,
  buyReserveOut,
  sellReserveIn,
  sellReserveOut,
  tradeSize,
  gasUsed = 0n,
  gasPrice = 0n
}) {
  try {
    if (
      !buyReserveIn ||
      !buyReserveOut ||
      !sellReserveIn ||
      !sellReserveOut ||
      tradeSize <= 0n
    ) {
      return null;
    }

    const FLASH_FEE_NUM = 9n;
    const FLASH_FEE_DEN = 10000n;

    // -------------------------
    // Swap 1
    // -------------------------
    console.log("BUY PRICE CHECK", {
      reserveIn: buyReserveIn.toString(),
      reserveOut: buyReserveOut.toString(),
      spotPrice:
        Number(buyReserveIn) /
        Number(buyReserveOut)
    });

    // WETH -> Token
    const swap1Out = simulateSwap(
      tradeSize,
      buyReserveIn,   // WETH
      buyReserveOut   // Token
    );

    console.log("SWAP1", {
      tradeSize: tradeSize.toString(),
      buyReserveIn: buyReserveIn.toString(),
      buyReserveOut: buyReserveOut.toString(),
      swap1Out: swap1Out.toString()
    });

    // Token -> WETH
    const swap2Out = simulateSwap(
      swap1Out,
      sellReserveOut, // Token
      sellReserveIn   // WETH
    );

    console.log("SWAP2", {
      swap1Out: swap1Out.toString(),
      sellReserveOut: sellReserveOut.toString(),
      sellReserveIn: sellReserveIn.toString(),
      swap2Out: swap2Out.toString()
    });

    if (swap2Out <= 0n) return null;

    // -------------------------
    // Fees
    // -------------------------
    const flashFee =
      (tradeSize * FLASH_FEE_NUM) / FLASH_FEE_DEN;

    // -------------------------
    // Gas
    // -------------------------
    const gasCostInWei = gasUsed * gasPrice;

    // -------------------------
    // Profit
    // -------------------------
    const rawProfit =
      swap2Out - tradeSize - flashFee - gasCostInWei;

    const netProfit = rawProfit > 0n ? rawProfit : 0n;
    //console.log("PROFIT BREAKDOWN", {
    //  swap2Out: swap2Out.toString(),
    //  tradeSize: tradeSize.toString(),
    //  flashFee: flashFee.toString(),
    //  gasCostInWei: gasCostInWei.toString(),
    //  rawProfit: rawProfit.toString()
    //});

    console.log({
      tradeWeth: formatUnits(tradeSize, 18),
      linkOut: formatUnits(swap1Out, 18),
      wethBack: formatUnits(swap2Out, 18),
      profit: formatUnits(rawProfit, 18)
    });

    return {
      swap1Out,
      swap2Out,
      flashFee,
      gasCostInWei,
      profit: netProfit
    };
  } catch (err) {
    console.error("estimateMaxProfit error:", err);
    return null;
  }
}

module.exports = {
  determineNetwork,
  getSigner,
  getOrCreatePairContract,
  safeGetTransaction,
  resetProvider,
  getReserves,
  getWethReserve,
  evaluateLiquidity,
  getFlashLoanSize,
  estimateMaxProfit
};

///// Works and up to date!!
