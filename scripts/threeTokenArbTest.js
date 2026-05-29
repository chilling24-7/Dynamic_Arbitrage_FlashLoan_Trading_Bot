const hre = require("hardhat");
const { ethers, network } = hre;

// ===== Constants =====
const UNI_ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D".toLowerCase();
const SUSHI_ROUTER = "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F".toLowerCase();
const UNI_FACTORY = "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f".toLowerCase();
const SUSHI_FACTORY = "0xC0AEe478e3658e2610c5F7A4A2E1777cE9e4f2Ac".toLowerCase();
const WETH = "0xC02aaA39b223FE8D0A0e5c4f27eAD9083C756Cc2".toLowerCase();
const PRECISION = 10n ** 18n;

// ===== Token Config =====
const LOOKS_ADDRESS = "0xf4d2888d29D722226FafA5d9B24F9164c092421E".toLowerCase();
const LOOKS_WHALE = "0xA4644953Ad98ED5A7ff106ED9a3909C9AEbcBC31".toLowerCase();
const USDC_ADDRESS = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48".toLowerCase();
const USDC_WHALE = "0x55fe002aeff02f77364de339a1292923a15844b8".toLowerCase();
const USDC_DECIMALS = 6;

// ===== Settings =====
const liquidityTokens = "1000";  // LOOKS to transfer from whale
const swapWeth = "10";           // WETH to swap
const wethLiquidity = "10";      // ETH to wrap for liquidity

// ===== ABIs =====
const ERC20_ABI = [
    "function balanceOf(address) view returns(uint256)",
    "function approve(address,uint256) returns(bool)",
    "function transfer(address,uint256) returns(bool)",
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

// ===== Math Helpers =====
function computePrice(reserveOut, reserveIn) {
    return (reserveOut * PRECISION) / reserveIn;
}
function percentChange(before, after) {
    return Number(((after - before) * 10000n) / before) / 100;
}

// ===== Add liquidity helper =====
async function addLiquidityForDex(factory, router, dexName, tokenAmount, usdcAmount, trader) {
    const token = await ethers.getContractAt(ERC20_ABI, LOOKS_ADDRESS, trader);
    const usdc = await ethers.getContractAt(ERC20_ABI, USDC_ADDRESS, trader);

    // Approvals for liquidity
    await token.connect(trader).approve(router.target || router, ethers.MaxUint256);
    await usdc.connect(trader).approve(router.target || router, ethers.MaxUint256);

    // Add liquidity
    const tx = await router.addLiquidity(
        LOOKS_ADDRESS,
        USDC_ADDRESS,
        tokenAmount,
        usdcAmount,
        0n,
        0n,
        await trader.getAddress(),
        BigInt(Math.floor(Date.now() / 1000) + 600)
    );
    await tx.wait();

    console.log(`💧 Added ${ethers.formatUnits(tokenAmount, await token.decimals())} LOOKS + ${ethers.formatUnits(usdcAmount, USDC_DECIMALS)} USDC to ${dexName}`);
}

// ===== Main Test Function =====
async function runOneSidedPump() {
    const trader = (await ethers.getSigners())[0];
    const traderAddress = await trader.getAddress();
    console.log(`🧪 Testing LOOKS (One-sided) with whale ${LOOKS_WHALE}\n`);

    // ===== Impersonate LOOKS whale =====
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [LOOKS_WHALE] });
    await network.provider.request({ method: "hardhat_setBalance", params: [LOOKS_WHALE, "0x1000000000000000000000"] });
    const whaleSigner = await ethers.getSigner(LOOKS_WHALE);

    // ===== Impersonate USDC whale =====
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [USDC_WHALE] });
    const usdcWhaleSigner = await ethers.getSigner(USDC_WHALE);

    // ===== Contracts =====
    const token = await ethers.getContractAt(ERC20_ABI, LOOKS_ADDRESS, trader);
    const weth = await ethers.getContractAt(ERC20_ABI, WETH, trader);
    const usdc = await ethers.getContractAt(ERC20_ABI, USDC_ADDRESS, trader);

    const uniFactory = await ethers.getContractAt(FACTORY_ABI, UNI_FACTORY, trader);
    const sushiFactory = await ethers.getContractAt(FACTORY_ABI, SUSHI_FACTORY, trader);

    const uniRouter = await ethers.getContractAt(ROUTER_ABI, UNI_ROUTER, trader);
    const sushiRouter = await ethers.getContractAt(ROUTER_ABI, SUSHI_ROUTER, trader);

    const tokenDecimals = await token.decimals();
    const liquidityTokenBN = ethers.parseUnits(liquidityTokens, tokenDecimals);

    // ===== Transfer LOOKS & USDC to trader =====
    await token.connect(whaleSigner).transfer(traderAddress, liquidityTokenBN);
    await usdc.connect(usdcWhaleSigner).transfer(traderAddress, ethers.parseUnits("2000", USDC_DECIMALS));

    console.log(`👤 Trader Balance: ${ethers.formatUnits(await token.balanceOf(traderAddress), tokenDecimals)} LOOKS, ${ethers.formatUnits(await usdc.balanceOf(traderAddress), USDC_DECIMALS)} USDC`);

    // ===== Split liquidity for both DEXes =====
    const tokenPerDex = liquidityTokenBN / 2n;
    const usdcPerDex = ethers.parseUnits("1000", USDC_DECIMALS);

    // ===== Add liquidity to both DEXes =====
    await addLiquidityForDex(uniFactory, uniRouter, "Uniswap", tokenPerDex, usdcPerDex, trader);
    await addLiquidityForDex(sushiFactory, sushiRouter, "SushiSwap", tokenPerDex, usdcPerDex, trader);

    // ===== Wrap ETH → WETH =====
    const wethLiquidityBN = ethers.parseEther(wethLiquidity);
    console.log(`🔄 Wrapping ${wethLiquidity} ETH → WETH`);
    await weth.connect(trader).deposit({ value: wethLiquidityBN });

    // ===== Approve router to spend WETH =====
    await weth.connect(trader).approve(UNI_ROUTER, ethers.MaxUint256);

    // ===== Get Uniswap LOOKS/WETH pair =====
    const pairAddress = await uniFactory.getPair(LOOKS_ADDRESS, WETH);
    if (pairAddress === ethers.ZeroAddress) throw new Error("LOOKS/WETH pair does not exist on Uniswap");

    const pair = await ethers.getContractAt(PAIR_ABI, pairAddress, trader);
    const token0 = await pair.token0();
    let [r0Before, r1Before] = await pair.getReserves();
    const [tokenReserveBefore, wethReserveBefore] = token0.toLowerCase() === LOOKS_ADDRESS ? [r0Before, r1Before] : [r1Before, r0Before];
    console.log(`Pair reserves BEFORE swap: ${ethers.formatUnits(tokenReserveBefore, tokenDecimals)} LOOKS, ${ethers.formatEther(wethReserveBefore)} WETH`);
    const uniPair = await ethers.getContractAt(PAIR_ABI, await uniFactory.getPair(LOOKS_ADDRESS, USDC_ADDRESS), trader);
    const sushiPair = await ethers.getContractAt(PAIR_ABI, await sushiFactory.getPair(LOOKS_ADDRESS, USDC_ADDRESS), trader);

    let [r0, r1] = await uniPair.getReserves();
    console.log("Uniswap reserves:", r0.toString(), r1.toString());

    [r0, r1] = await sushiPair.getReserves();
    console.log("SushiSwap reserves:", r0.toString(), r1.toString());

    // ===== Swap WETH → LOOKS (One-sided) =====
    const swapWethBN = ethers.parseEther(swapWeth);
    const balanceBefore = await token.balanceOf(traderAddress);
    await uniRouter.swapExactTokensForTokens(
        swapWethBN,
        0n,
        [WETH, LOOKS_ADDRESS],
        traderAddress,
        BigInt(Math.floor(Date.now() / 1000) + 600)
    );
    const balanceAfter = await token.balanceOf(traderAddress);
    console.log(`✅ Tokens received: ${ethers.formatUnits(balanceAfter - balanceBefore, tokenDecimals)} LOOKS`);

    // ===== Price change calculation =====
    const [r0After, r1After] = await pair.getReserves();
    const [tokenReserveAfter, wethReserveAfter] = token0.toLowerCase() === LOOKS_ADDRESS ? [r0After, r1After] : [r1After, r0After];
    const priceBefore = computePrice(wethReserveBefore, tokenReserveBefore);
    const priceAfter = computePrice(wethReserveAfter, tokenReserveAfter);
    const pct = percentChange(priceBefore, priceAfter);
    console.log(`📊 Price change on Uniswap LOOKS/WETH: Δ ${pct.toFixed(2)}%`);
}

runOneSidedPump().catch(console.error);

/////////////Works addes pairs and liquidity for both Dexes. /////