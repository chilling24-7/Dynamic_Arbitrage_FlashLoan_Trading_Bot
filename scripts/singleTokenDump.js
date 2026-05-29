/**
 * Generic Token Pump/Dump Test (Multi-Token, Accurate ROI)
 * Ethers v6 + BigInt safe
 */

const hre = require("hardhat");
const { ethers, network } = hre;

// ===== Constants =====
const UNI_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D".toLowerCase();
const FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f".toLowerCase();
const WETH = "0xC02aaA39b223FE8D0A0e5c4f27eAD9083C756Cc2".toLowerCase();
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();
const PRECISION = 10n ** 18n;

// ===== Router registry =====
const ROUTERS = { [UNI_ROUTER]: "Uniswap V2" };

// ===== Token config =====
const TOKEN_CONFIG = {
  LINK: {
    symbol: "LINK",
    address: "0x514910771af9ca656af840dff83e8264ecf986ca".toLowerCase(),
    whale: "0xF977814e90dA44bFA03b6295A0616a897441aceC".toLowerCase()
  },
  LDO: {
    symbol: "LDO",
    address: "0x5a98fcbea516cf06857215779fd812ca3bef1b32".toLowerCase(),
    whale: "0xF977814e90dA44bFA03b6295A0616a897441aceC".toLowerCase()
  },
  AAVE: {
    symbol: "AAVE",
    address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9".toLowerCase(),
    whale: "0x25f2226b597e8f9514b3f68f00f494cf4f286491".toLowerCase()
  },
  SHIB: {
    symbol: "SHIB",
    address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE".toLowerCase(),
    whale: "0x28C6c06298d514Db089934071355E5743bf21d60".toLowerCase()
  }
};

// ===== Token symbols =====
const TOKEN_SYMBOLS = {
  [WETH]: "WETH",
  [USDC]: "USDC",
  ...Object.fromEntries(Object.values(TOKEN_CONFIG).map(t => [t.address, t.symbol]))
};

// ===== Swap settings =====
const liquidityTokens = "20000";
const swapTokens = "10000";
const wethLiquidity = "50";

// ===== ABIs =====
const ERC20_ABI = [
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function allowance(address,address) view returns(uint256)",
  "function decimals() view returns(uint8)",
  "function deposit() payable"
];
const FACTORY_ABI = ["function getPair(address,address) view returns(address)"];
const PAIR_ABI = [
  "function getReserves() view returns(uint112,uint112,uint32)",
  "function token0() view returns(address)"
];
const ROUTER_ABI = [
  "function swapExactTokensForTokens(uint,uint,address[],address,uint) returns(uint[])",
  "function addLiquidity(address,address,uint,uint,uint,uint,address,uint)"
];

// ===== Helpers =====
function resolveSymbol(address) {
  return TOKEN_SYMBOLS[address.toLowerCase()] || address.slice(0, 6);
}
function resolveRouterName(address) {
  return ROUTERS[address.toLowerCase()] || "Unknown Router";
}
function formatPath(path) {
  return path.map(resolveSymbol).join(" → ");
}
function computePrice(reserveOut, reserveIn) {
  return (reserveOut * PRECISION) / reserveIn;
}
function toFloat(priceBigInt) {
  return Number(priceBigInt) / 1e18;
}
function percentChange(before, after) {
  return Number(((after - before) * 10000n) / before) / 100;
}

// ===== Display =====
const ORANGE = "\x1b[38;5;208m";
const RESET = "\x1b[0m";

function displayResult({
  tokenSymbol,
  priceBefore,
  priceAfter,
  priceBeforeUSDC,
  priceAfterUSDC,
  percent,
  tokenReserveAfter,
  wethReserveAfter,
  tokenDecimals,
  routerAddress,
  routerPath,
  profitWETH,
  profitUSDC,
  roi
}) {
  console.log(ORANGE + "══════════════════════════════════════════════════════════" + RESET);
  console.log(`💰 Token: ${tokenSymbol}`);
  console.log(`🔹 Liquidity Pool: ${tokenSymbol}/WETH`);
  console.log(ORANGE + "══════════════════════════════════════════════════════════" + RESET);

  console.log("\n💸 Price BEFORE Swap");
  console.log(`1 ${tokenSymbol} ≈ ${toFloat(priceBefore)} WETH`);
  console.log(`1 ${tokenSymbol} ≈ ${priceBeforeUSDC.toFixed(6)} USDC`);

  console.log("\n💸 Price AFTER Swap");
  console.log(`1 ${tokenSymbol} ≈ ${toFloat(priceAfter)} WETH`);
  console.log(`1 ${tokenSymbol} ≈ ${priceAfterUSDC.toFixed(6)} USDC`);

  console.log("\n📊 Price Change");
  console.log(`Δ %: ${percent.toFixed(4)}%`);

  console.log("\n🧭 Router");
  console.log(resolveRouterName(routerAddress));

  console.log("\n🔀 Path");
  console.log(formatPath(routerPath));

  console.log("\n📈 Reserves");
  console.log(`${tokenSymbol}: ${ethers.formatUnits(tokenReserveAfter, tokenDecimals)}`);
  console.log(`WETH: ${ethers.formatEther(wethReserveAfter)}`);

  console.log("\n🚀 Estimated Swap Profit / ROI:");
  console.log(`Profit (WETH): ${profitWETH.toFixed(6)}`);
  console.log(`Profit (USDC): ${profitUSDC.toFixed(2)}`);
  console.log(`ROI: ${roi.toFixed(4)} %`);

  console.log(ORANGE + "══════════════════════════════════════════════════════════" + RESET);
}

// ===== Main Test =====
async function runGenericTest(symbol) {
  const config = TOKEN_CONFIG[symbol];
  const whale = config.whale;

  console.log(`\n🧪 Testing ${symbol} with whale ${whale}\n`);

  await network.provider.request({ method: "hardhat_impersonateAccount", params: [whale] });
  await network.provider.request({ method: "hardhat_setBalance", params: [whale, "0x1000000000000000000000"] });

  const signer = await ethers.getSigner(whale);
  const token = await ethers.getContractAt(ERC20_ABI, config.address);
  const weth = await ethers.getContractAt(ERC20_ABI, WETH);
  const usdc = await ethers.getContractAt(ERC20_ABI, USDC);

  const tokenDecimals = await token.decimals();
  const usdcDecimals = await usdc.decimals();

  const liquidityTokenBN = ethers.parseUnits(liquidityTokens, tokenDecimals);
  const swapTokenBN = ethers.parseUnits(swapTokens, tokenDecimals);
  const wethLiquidityBN = ethers.parseEther(wethLiquidity);

  const whaleBalance = await token.balanceOf(whale);
  console.log(`💰 Whale Balance: ${ethers.formatUnits(whaleBalance, tokenDecimals)} ${symbol}`);
  if (BigInt(whaleBalance) < swapTokenBN) throw new Error("Whale lacks tokens for swap");

  const router = await ethers.getContractAt(ROUTER_ABI, UNI_ROUTER);
  const factory = await ethers.getContractAt(FACTORY_ABI, FACTORY);

  // Approvals
  const tokenAllowance = await token.allowance(whale, UNI_ROUTER);
  if (BigInt(tokenAllowance) < liquidityTokenBN + swapTokenBN) await token.connect(signer).approve(UNI_ROUTER, ethers.MaxUint256);
  const wethAllowance = await weth.allowance(whale, UNI_ROUTER);
  if (BigInt(wethAllowance) < wethLiquidityBN) await weth.connect(signer).approve(UNI_ROUTER, ethers.MaxUint256);

  // Get Pair & reserves
  const pairAddress = await factory.getPair(config.address, WETH);
  const pair = await ethers.getContractAt(PAIR_ABI, pairAddress);
  const token0 = await pair.token0();
  const [r0Before, r1Before] = await pair.getReserves();
  const [tokenReserveBefore, wethReserveBefore] = token0.toLowerCase() === config.address ? [r0Before, r1Before] : [r1Before, r0Before];

  // Add liquidity only if needed
  if (BigInt(tokenReserveBefore) < liquidityTokenBN / 2n) {
    console.log("💧 Adding liquidity...");
    await weth.connect(signer).deposit({ value: wethLiquidityBN });
    await router.connect(signer).addLiquidity(
      config.address,
      WETH,
      liquidityTokenBN,
      wethLiquidityBN,
      0n,
      0n,
      whale,
      BigInt(Math.floor(Date.now() / 1000) + 600)
    );
    console.log("✅ Liquidity added");
  } else {
    console.log("ℹ️ Liquidity sufficient, skipping addLiquidity");
  }

  // WETH/USDC price
  const wuPairAddr = await factory.getPair(WETH, USDC);
  const wuPair = await ethers.getContractAt(PAIR_ABI, wuPairAddr);
  const token0wu = await wuPair.token0();
  const [wu0, wu1] = await wuPair.getReserves();
  const [wethRes, usdcRes] = token0wu.toLowerCase() === WETH ? [wu0, wu1] : [wu1, wu0];
  const wethPriceUSDC = Number(ethers.formatUnits(usdcRes, usdcDecimals)) / Number(ethers.formatEther(wethRes));

  const priceBefore = computePrice(wethReserveBefore, tokenReserveBefore);
  const priceBeforeUSDC = toFloat(priceBefore) * wethPriceUSDC;

  // Swap calculation
  console.log(`🔄 Swapping ${swapTokens} ${symbol}`);
  const swapPath = [config.address, WETH];
  const amountInWithFee = swapTokenBN * 997n / 1000n;
  const numerator = amountInWithFee * wethReserveBefore;
  const denominator = tokenReserveBefore + amountInWithFee;
  const wethOutBN = numerator / denominator;

  await router.connect(signer).swapExactTokensForTokens(
    swapTokenBN,
    0n,
    swapPath,
    whale,
    BigInt(Math.floor(Date.now() / 1000) + 600)
  );

  // Reserves after swap
  const [r0After, r1After] = await pair.getReserves();
  const [tokenReserveAfter, wethReserveAfter] = token0.toLowerCase() === config.address ? [r0After, r1After] : [r1After, r0After];
  const priceAfter = computePrice(wethReserveAfter, tokenReserveAfter);
  const priceAfterUSDC = toFloat(priceAfter) * wethPriceUSDC;
  const pct = percentChange(priceBefore, priceAfter);

  // Realized profit
  const profitWETH = Number(ethers.formatEther(wethOutBN)) - (Number(ethers.formatUnits(swapTokenBN, tokenDecimals)) * toFloat(priceBefore));
  const profitUSDC = profitWETH * wethPriceUSDC;
  const roi = (profitWETH / (Number(ethers.formatUnits(swapTokenBN, tokenDecimals)) * toFloat(priceBefore))) * 100;

  displayResult({
    tokenSymbol: symbol,
    priceBefore,
    priceAfter,
    priceBeforeUSDC,
    priceAfterUSDC,
    percent: pct,
    tokenReserveAfter,
    wethReserveAfter,
    tokenDecimals,
    routerAddress: UNI_ROUTER,
    routerPath: swapPath,
    profitWETH,
    profitUSDC,
    roi
  });
}

// ===== Run all tokens sequentially =====
async function runAllTokens() {
  for (const token of Object.keys(TOKEN_CONFIG)) {
    try {
      await runGenericTest(token);
    } catch (err) {
      console.error(`❌ Error testing ${token}:`, err);
    }
  }
}

//runAllTokens();
// ===== RUN TEST =====
runGenericTest("LINK").catch(console.error);


// runGenericTest("SHIB")
// runGenericTest("LINK")
// runGenericTest("AAVE")
// runGenericTest("LINK")
