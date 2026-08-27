const { ethers } = require("ethers");

// ----------------- Get Flash Loan Size -----------------
async function getFlashLoanSize(params = {}) {
    const {
        quoter,
        tradeCandidate,
        baseToken,
        targetToken
    } = params;

    if (!quoter || !tradeCandidate || !baseToken || !targetToken) {
        console.log("❌ getFlashLoanSize missing inputs");
        return null;
    }

    const flashToken = baseToken.address;
    const tradeToken = targetToken.address;

    const buyPool = {address: tradeCandidate.firstSwap.pool, fee: tradeCandidate.firstSwap.fee};
    const sellPool = {address: tradeCandidate.secondSwap.pool, fee: tradeCandidate.secondSwap.fee};

    let best = null;
    let amount = ethers.parseUnits("0.01", 18);

    let declineCount = 0;
    let previousProfit = null;

    console.log("\n──────── FLASH SIZE SEARCH ────────");
    console.log("Searching optimal flash size...");

    while (amount <= ethers.parseUnits("100", 18)) {
        try {

            const buyAmount = BigInt(
                (
                    await quoter.quoteExactInputSingle.staticCall(
                        flashToken,
                        tradeToken,
                        Number(buyPool.fee),
                        amount,
                        0n
                    )
                ).toString()
            );

            const sellAmount = BigInt(
                (
                    await quoter.quoteExactInputSingle.staticCall(
                        tradeToken,
                        flashToken,
                        Number(sellPool.fee),
                        buyAmount,
                        0n
                    )
                ).toString()
            );

            const flashFee = amount * 9n / 10000n;

            const grossProfit = sellAmount - amount;

            const netProfit = grossProfit - flashFee;

            if (!best || netProfit > best.netProfit) {

                best = {
                    amount,
                    buyPool,
                    sellPool,
                    buyAmount,
                    sellAmount,
                    grossProfit,
                    flashFee,
                    netProfit
                };

            }

            if (previousProfit !== null) {

                if (netProfit < previousProfit) {
                    declineCount++;
                } else {
                    declineCount = 0;
                }

                if (declineCount >= 3) {
                    break;
                }

            }

            previousProfit = netProfit;

            // Double search size
            amount *= 2n;

        } catch {

            break;

        }
    }

    console.log("FLASH ROUTE DEBUG");
    console.log("BUY");
    console.log(" tokenIn :", flashToken);
    console.log(" tokenOut:", tradeToken);
    console.log(" fee     :", buyPool.fee);
    console.log(" pool    :", buyPool.address);

    console.log("SELL");
    console.log(" tokenIn :", tradeToken);
    console.log(" tokenOut:", flashToken);
    console.log(" fee     :", sellPool.fee);
    console.log(" pool    :", sellPool.address);
    console.log("\n──────── BEST FLASH SIZE ────────");

    if (!best || best.netProfit <= 0n) {console.log("❌ No profitable flash size found");
        return null;
    }

    console.log(`Borrow : ${ethers.formatUnits(best.amount,18)} ${baseToken.symbol}`);
    console.log(`Buy    : Pool ${best.buyPool.fee}`);
    console.log(`Sell   : Pool ${best.sellPool.fee}`);
    console.log(`Net    : ${ethers.formatUnits(best.netProfit,18)} ${baseToken.symbol}`);

    return best;
}

function generateLoanSizes(maxLoan, decimals = 18n) {
    const sizes = [
        ethers.parseUnits(".01", Number(decimals)),
        ethers.parseUnits("1", Number(decimals)),
        ethers.parseUnits("5", Number(decimals)),
        ethers.parseUnits("10", Number(decimals))
    ];

    return sizes.filter(size => size <= maxLoan);
}

const DEBUG_SIM = false; // or true when debugging

async function validatePool(poolAddress, executionProvider) {
  try {
    const pool = new ethers.Contract(
      poolAddress,
      [
        "function token0() view returns(address)",
        "function token1() view returns(address)",
        "function liquidity() view returns(uint128)",
        "function slot0() view returns(uint160,int24,uint16,uint16,uint16,uint8,bool)"
      ],
      executionProvider
    );

    const [token0, token1, liquidity, slot0] = await Promise.all([
      pool.token0(),
      pool.token1(),
      pool.liquidity(),
      pool.slot0()
    ]);

    if (liquidity === 0n)
      return null;

    const sqrtPriceX96 = slot0[0];

    if (sqrtPriceX96 === 0n)
      return null;

    return {
      valid: true,
      token0: token0.toLowerCase(),
      token1: token1.toLowerCase(),
      liquidity,
      sqrtPriceX96
    };

  } catch (e) {
    return null;
  }
}


async function checkPoolTradeability(pool, WETH, tradeToken, quoter, factory, eventBlock, wethDecimals = 18) {
    const testAmountIn = ethers.parseUnits("0.03", wethDecimals);
    const fail = (reason, extra = {}) => ({
        usable: false,
        reason,
        testAmountIn,
        testAmountOut: 0n,
        tradeDecimals: 18,
        testAmountOutFormatted: "0",
        eventBlock,
        ...extra
    });

    // =====================================================
    // BASIC VALIDATION
    // =====================================================

    if (eventBlock == null) return fail("missing event block");
    if (!pool?.liquidity || BigInt(pool.liquidity) === 0n) return fail("zero active liquidity");
    if (!WETH || !tradeToken) return fail("missing WETH/trade token");
    if (!quoter) return fail("quoter unavailable");
    if (!pool?.fee && pool?.fee !== 0) return fail("missing pool fee");

    // =====================================================
    // TOKEN DECIMALS
    // =====================================================

    let tradeDecimals = 18;

    try {
        const token = new ethers.Contract(tradeToken, ["function decimals() view returns(uint8)"], quoter.runner);
        tradeDecimals = Number(await token.decimals({ blockTag: eventBlock }));
    } catch (e) {}

    // =====================================================
    // BOTH DIRECTIONS
    //
    // WETH → TRADE TOKEN
    // TRADE TOKEN → WETH
    //
    // The reverse leg uses the exact output of leg 1.
    // =====================================================

    let testAmountOut = 0n;

    try {
        // =================================================
        // LEG 1: WETH → TRADE TOKEN
        // =================================================

        const buyResult = await quoter.quoteExactInputSingle.staticCall(
            WETH,
            tradeToken,
            Number(pool.fee),
            testAmountIn,
            0n,
            { blockTag: eventBlock }
        );

        testAmountOut = BigInt(
            Array.isArray(buyResult) || buyResult?.length !== undefined
                ? buyResult[0].toString()
                : buyResult.toString()
        );

        if (testAmountOut === 0n) {
            return {
                ...fail("WETH → trade token returned zero"),
                tradeDecimals,
                testAmountOut
            };
        }

        // =================================================
        // LEG 2: TRADE TOKEN → WETH
        // =================================================

        const sellResult = await quoter.quoteExactInputSingle.staticCall(
            tradeToken,
            WETH,
            Number(pool.fee),
            testAmountOut,
            0n,
            { blockTag: eventBlock }
        );

        const wethReturned = BigInt(
            Array.isArray(sellResult) || sellResult?.length !== undefined
                ? sellResult[0].toString()
                : sellResult.toString()
        );

        if (wethReturned === 0n) {
            return {
                ...fail("trade token → WETH returned zero"),
                tradeDecimals,
                testAmountOut,
                testAmountOutFormatted: ethers.formatUnits(testAmountOut, tradeDecimals),
                wethReturned,
                wethReturnedFormatted: "0"
            };
        }

        // =================================================
        // SUCCESS
        // =================================================

        return {
            usable: true,
            reason: "both directions executable",

            testAmountIn,
            testAmountOut,
            testAmountOutFormatted: ethers.formatUnits(testAmountOut, tradeDecimals),

            tradeDecimals,

            wethReturned,
            wethReturnedFormatted: ethers.formatUnits(wethReturned, wethDecimals),

            roundTripDifference: wethReturned - testAmountIn,

            eventBlock
        };

    } catch (e) {

        console.log("QUOTE DEBUG", {
            pool: pool?.address,
            fee: pool?.fee,
            WETH,
            tradeToken,
            eventBlock,
            error: e.shortMessage || e.reason || e.message,
            data: e.data
        });

        return {
            ...fail(
                `round-trip quote failed: ${e.shortMessage || e.reason || e.message}`
            ),
            tradeDecimals,
            testAmountOut,
            testAmountOutFormatted: testAmountOut > 0n
                ? ethers.formatUnits(testAmountOut, tradeDecimals)
                : "0"
        };
    }
}


const decimalsCache=new Map();

// =====================================================
// BigInt Display Formatting
// =====================================================

function formatCompactBigInt(value) {

    const units = [
        { div: 1_000_000_000_000_000_000n, suffix: "E" },
        { div: 1_000_000_000_000_000n, suffix: "P" },
        { div: 1_000_000_000_000n, suffix: "T" },
        { div: 1_000_000_000n, suffix: "B" },
        { div: 1_000_000n, suffix: "M" },
        { div: 1_000n, suffix: "K" }
    ];

    for (const u of units) {

        if (value >= u.div) {

            const whole = value / u.div;
            const frac = (value % u.div) * 100n / u.div;

            return `${whole}.${frac.toString().padStart(2,"0")}${u.suffix}`;
        }
    }

    return value.toString();
}

function minSpread(buyFee, sellFee, bufferPercent = 0) {
    const buyFeeRate = Number(buyFee) / 1_000_000;
    const sellFeeRate = Number(sellFee) / 1_000_000;

    const feeBreakEven =
        (1 / ((1 - buyFeeRate) * (1 - sellFeeRate))) - 1;

    return (feeBreakEven * 100) + bufferPercent;
}


// =====================================================
// Console Column Formatting
// =====================================================

module.exports = {
  getFlashLoanSize,
  generateLoanSizes,
  checkPoolTradeability,
  validatePool,
  formatCompactBigInt,
  minSpread
};

///// Works and up to date!!
//analyze() was selecting a route based on a misleading spot-price comparison, and the 0.01%/0.05% pool data was not being compared in the same way as the actual trade quote.
