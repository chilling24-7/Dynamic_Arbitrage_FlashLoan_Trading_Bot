const hre = require("hardhat");
const { ethers, network } = hre;

// ===== Constants =====
const UNI_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D".toLowerCase();
const FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f".toLowerCase();
const WETH = "0xC02aaA39b223FE8D0A0e5c4f27eAD9083C756Cc2".toLowerCase();
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();
const PRECISION = 10n ** 18n;

// ===== Display Colors =====
const ORANGE = "\x1b[38;5;208m";
const RESET = "\x1b[0m";
function border() {
    console.log(ORANGE + "══════════════════════════════════════════════════════════" + RESET);
}

// ===== Router Registry =====
const ROUTERS = {
    [UNI_ROUTER]: "Uniswap V2",
    "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f": "SushiSwap"
};
function resolveRouterName(address) {
    return ROUTERS[address.toLowerCase()] || "Unknown Router";
}

// ===== Token Config =====
const TOKEN_CONFIG = {
    LDO: { symbol: "LDO", address: "0x5a98fcbea516cf06857215779fd812ca3bef1b32".toLowerCase(), whale: "0xF977814e90dA44bFA03b6295A0616a897441aceC".toLowerCase() },
    LINK: { symbol: "LINK", address: "0x514910771af9ca656af840dff83e8264ecf986ca".toLowerCase(), whale: "0xF977814e90dA44bFA03b6295A0616a897441aceC".toLowerCase() },
    AAVE: { symbol: "AAVE", address: "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9".toLowerCase(), whale: "0x25f2226b597e8f9514b3f68f00f494cf4f286491".toLowerCase() },
    SHIB: { symbol: "SHIB", address: "0x95aD61b0a150d79219dCF64E1E6Cc01f0B64C4cE".toLowerCase(), whale: "0x28C6c06298d514Db089934071355E5743bf21d60".toLowerCase() },
    ALCX: { symbol: "ALCX", address: "0xDBdBd135c4fAf1a816bBb8d85Ca20b9b215Ebb81".toLowerCase(), whale: "0xF977814e90dA44bFA03b6295A0616a897441aceC".toLowerCase()}
};

// ===== Token Symbol Registry =====
const TOKEN_SYMBOLS = { [WETH]: "WETH", [USDC]: "USDC" };
for (const t of Object.values(TOKEN_CONFIG)) TOKEN_SYMBOLS[t.address] = t.symbol;
function resolveSymbol(address) { return TOKEN_SYMBOLS[address.toLowerCase()] || address.slice(0,6); }

// ===== Settings =====
const liquidityTokens = "20000";
const swapWeth = "10";
const wethLiquidity = "50";

// ===== ABIs =====
const ERC20_ABI = [
    "function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)",
    "function transfer(address,uint256) returns(bool)",
    "function decimals() view returns(uint8)",
    "function allowance(address,address) view returns(uint256)",
    "function deposit() payable"
];
const FACTORY_ABI = [
    "function getPair(address,address) view returns(address)",
    "function createPair(address,address) returns(address)"
];
const PAIR_ABI = [
    "function getReserves() view returns(uint112,uint112,uint32)",
    "function token0() view returns(address)"
];
const ROUTER_ABI = [
    "function swapExactTokensForTokens(uint,uint,address[],address,uint) returns(uint[])",
    "function addLiquidity(address,address,uint,uint,uint,uint,address,uint)"
];

// ===== Math Helpers =====
function computePrice(reserveOut, reserveIn) { return (reserveOut * PRECISION) / reserveIn; }
function toFloat(priceBigInt) { return Number(priceBigInt) / 1e18; }
function percentChange(before, after) { return Number(((after - before) * 10000n) / before) / 100; }
function formatPath(path) { return path.map(resolveSymbol).join(" → "); }

// ===== Display Function ===== await router
function displayResult({
    tokenSymbol, priceBefore, priceAfter, priceBeforeUSDC, priceAfterUSDC,
    percent, tokenReserveAfter, wethReserveAfter, tokenDecimals,
    routerAddress, routerPath, tradeWeth, tokensReceived,
    profitWETH, profitUSDC, roi
}) {
    border();
    console.log(`💰 Token: ${tokenSymbol}`);
    console.log(`🔹 Liquidity Pool: ${tokenSymbol}/WETH`);
    border();

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

    console.log("\n📊 Trade Analytics");
    console.log(`Trade Size: ${tradeWeth} WETH`);
    console.log(`Tokens Received: ${tokensReceived} ${tokenSymbol}`);

    console.log("\n🚀 Estimated Swap Profit / ROI:");
    console.log(`Profit (WETH): ${profitWETH.toFixed(6)}`);
    console.log(`Profit (USDC): ${profitUSDC.toFixed(2)}`);
    console.log(`ROI: ${roi.toFixed(4)} %`);

    border();
}

// ===== Main Test Function =====
async function runGenericPump(symbol) {
    if (!TOKEN_CONFIG[symbol]) throw new Error(`Token ${symbol} not defined in TOKEN_CONFIG`);

    const config = TOKEN_CONFIG[symbol];
    const trader = (await ethers.getSigners())[0];
    const whale = config.whale;

    console.log(`🧪 Testing ${symbol} with whale ${whale}\n`);

    // ===== Impersonate whale and set balance =====
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [whale] });
    await network.provider.request({ method: "hardhat_setBalance", params: [whale, "0x1000000000000000000000"] });
    const whaleSigner = await ethers.getSigner(whale);

    // ===== Contracts =====
    const token = await ethers.getContractAt(ERC20_ABI, config.address, trader);
    const weth = await ethers.getContractAt(ERC20_ABI, WETH, trader);
    const usdc = await ethers.getContractAt(ERC20_ABI, USDC, trader);
    const router = await ethers.getContractAt(ROUTER_ABI, UNI_ROUTER, trader);
    const factory = await ethers.getContractAt(FACTORY_ABI, FACTORY, trader);

    const tokenDecimals = await token.decimals();
    const usdcDecimals = await usdc.decimals();
    const liquidityTokenBN = ethers.parseUnits(liquidityTokens, tokenDecimals);
    const swapWethBN = ethers.parseEther(swapWeth);
    const wethLiquidityBN = ethers.parseEther(wethLiquidity);

    const traderAddress = await trader.getAddress();
    const traderEthBalance = await trader.provider.getBalance(traderAddress);
    console.log(`Trader ETH balance: ${ethers.formatEther(traderEthBalance)} ETH`);

    // ===== Transfer tokens from whale first =====
    const whaleBalance = await token.balanceOf(whale);
    console.log(`💰 Whale Balance: ${ethers.formatUnits(whaleBalance, tokenDecimals)} ${symbol}`);
    await token.connect(whaleSigner).transfer(traderAddress, liquidityTokenBN);
    const traderBalance = await token.balanceOf(traderAddress);
    console.log(`👤 Trader Balance after transfer: ${ethers.formatUnits(traderBalance, tokenDecimals)} ${symbol}`);

    // ===== Approvals AFTER transfer =====
    await token.connect(trader).approve(UNI_ROUTER, 0);                   // reset allowance first
    await token.connect(trader).approve(UNI_ROUTER, ethers.MaxUint256);  // then approve max
    await weth.connect(trader).approve(UNI_ROUTER, ethers.MaxUint256);   // approve WETH once

    // ===== Wrap ETH → WETH =====
    console.log(`🔄 Wrapped ${wethLiquidity} ETH → WETH`);
    await weth.connect(trader).deposit({ value: wethLiquidityBN });

    // ===== Get or create pair =====
    let pairAddress = await factory.getPair(config.address, WETH);
    if (pairAddress === ethers.ZeroAddress) {
        console.log(`⚠️ Pair does not exist, creating...`);
        await factory.createPair(config.address, WETH);
        pairAddress = await factory.getPair(config.address, WETH);
    }
    console.log(`✅ Pair exists: ${pairAddress}`);

    const pair = await ethers.getContractAt(PAIR_ABI, pairAddress, trader);
    const token0 = await pair.token0();
    let [r0Before, r1Before] = await pair.getReserves();
    const [tokenReserveBefore, wethReserveBefore] = token0.toLowerCase() === config.address ? [r0Before, r1Before] : [r1Before, r0Before];
    console.log(`Pair reserves BEFORE swap: ${ethers.formatUnits(tokenReserveBefore, tokenDecimals)} ${symbol}, ${ethers.formatEther(wethReserveBefore)} WETH`);

    // ===== Swap WETH → Token =====
    console.log(`🔄 Swapping ${swapWeth} WETH → ${symbol}`);
    const swapPath = [WETH, config.address];
    const balanceBefore = await token.balanceOf(traderAddress);
    const tx = await router.swapExactTokensForTokens(
  swapWethBN,
  0n,
  swapPath,
  traderAddress,
  BigInt(Math.floor(Date.now()/1000)+600)
);

const receipt = await tx.wait();

console.log("🧾 Swap tx mined in block:", receipt.blockNumber);
console.log("🧾 Receipt logs count:", receipt.logs.length);
    const balanceAfter = await token.balanceOf(traderAddress);
    const tokensReceived = Number(ethers.formatUnits(balanceAfter - balanceBefore, tokenDecimals));

    const [r0After, r1After] = await pair.getReserves();
    const [tokenReserveAfter, wethReserveAfter] = token0.toLowerCase() === config.address ? [r0After, r1After] : [r1After, r0After];
    const priceBefore = computePrice(wethReserveBefore, tokenReserveBefore);
    const priceAfter = computePrice(wethReserveAfter, tokenReserveAfter);

    // ===== WETH → USDC price =====
    const wethUsdcPairAddr = await factory.getPair(WETH, USDC);
    const wethUsdcPair = await ethers.getContractAt(PAIR_ABI, wethUsdcPairAddr, trader);
    const token0wu = await wethUsdcPair.token0();
    const [wu0, wu1] = await wethUsdcPair.getReserves();
    const [wethRes, usdcRes] = token0wu.toLowerCase() === WETH ? [wu0, wu1] : [wu1, wu0];
    const wethPriceUSDC = Number(ethers.formatUnits(usdcRes, usdcDecimals)) / Number(ethers.formatEther(wethRes));
    const priceBeforeUSDC = toFloat(priceBefore) * wethPriceUSDC;
    const priceAfterUSDC = toFloat(priceAfter) * wethPriceUSDC;
    const pct = percentChange(priceBefore, priceAfter);

    // ===== Profit + ROI =====
    const tradeSizeWETH = Number(swapWeth);
    const wethValueAfter = tokensReceived * toFloat(priceAfter);  // Value of tokens in WETH after swap
    const profitWETH = wethValueAfter - tradeSizeWETH;
    const profitUSDC = profitWETH * wethPriceUSDC;
    const roi = (profitWETH / tradeSizeWETH) * 100;

    // ===== Display =====
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
        tradeWeth: swapWeth,
        tokensReceived,
        profitWETH,
        profitUSDC,
        roi
    });
}

runGenericPump("LINK").catch(console.error);
// runGenericPump("LDO");
// runGenericPump("AAVE");
// runGenericPump("SHIB");
// runGenericPump("ALCX").catch(console.error);