const hre = require("hardhat");
const { ethers } = hre;


// =====================================================
// CONFIG
// =====================================================

const CONFIG = {
  TOKEN: {
    symbol: "LINK",
    address: "0xf97f4df75117a78c1a5a0dbb814af92458539fb4",
  },

  WETH: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",

  V3: {
    QUOTER: "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  },

  FEES: [500, 3000, 10000],
  PUMP_WETH: "100",
};


// =====================================================
// ABIS
// =====================================================

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
];


const QUOTER_ABI = [
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) returns (uint256)"
];


const ROUTER_ABI = [
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns (uint256)"
];


// =====================================================
// HELPERS
// =====================================================

const section = (x) => {
  console.log("\n═══════════════════════════════");
  console.log(x);
  console.log("═══════════════════════════════");
};


const pct = (before, after) => {

  if (before === 0n) return 0;

  return Number(
    ((after - before) * 10000n) / before
  ) / 100;

};


const price = (out, inAmt) => {

  if (inAmt === 0n) return 0n;

  return (out * 10n ** 18n) / inAmt;

};


const fmt = (x) => Number(x) / 1e18;



// =====================================================
// MAIN
// =====================================================

async function main() {


  // =====================================================
  // SNAPSHOT ORIGINAL POOL STATE
  // =====================================================

  const snapshot =
    await ethers.provider.send("evm_snapshot");


  console.log(
    "Snapshot created:",
    snapshot
  );



  try {


    const [trader] =
      await ethers.getSigners();



    section(`🧪 V3 PUMP EVENT ${CONFIG.TOKEN.symbol}`);



    const amountIn =
      ethers.parseEther(CONFIG.PUMP_WETH);



    console.log(
      "Trader:",
      trader.address
    );


    console.log(
      "Pump:",
      ethers.formatEther(amountIn),
      "WETH"
    );



    const weth =
      await ethers.getContractAt(
        ERC20_ABI,
        CONFIG.WETH
      );


    const token =
      await ethers.getContractAt(
        ERC20_ABI,
        CONFIG.TOKEN.address
      );


    const quoter =
      await ethers.getContractAt(
        QUOTER_ABI,
        CONFIG.V3.QUOTER
      );


    const router =
      await ethers.getContractAt(
        ROUTER_ABI,
        CONFIG.V3.ROUTER,
        trader
      );



    const tokenDecimals =
      await token.decimals();




    // =====================================================
    // WRAP
    // =====================================================

    await weth.deposit({
      value: amountIn
    });


    console.log("Wrapped");




    // =====================================================
    // FIND BEST ROUTE
    // =====================================================

    console.log("\nChecking fee tiers");


    let bestFee = null;
    let bestOut = 0n;



    for (const fee of CONFIG.FEES) {

      try {

        const out =
          await quoter.quoteExactInputSingle.staticCall(
            CONFIG.WETH,
            CONFIG.TOKEN.address,
            fee,
            amountIn,
            0
          );


        console.log(
          fee,
          ethers.formatUnits(
            out,
            tokenDecimals
          ),
          CONFIG.TOKEN.symbol
        );



        if (out > bestOut) {

          bestOut = out;
          bestFee = fee;

        }


      } catch {}

    }



    if (!bestFee || bestOut === 0n) {
      throw new Error("No valid pool");
    }



    console.log(
      "\nSelected fee:",
      bestFee
    );




    // =====================================================
    // BEFORE
    // =====================================================

    const priceBeforeRaw =
      price(
        bestOut,
        amountIn
      );



    console.log("\n💲 EXECUTION PRICE (BEFORE)");

    console.log(
      `1 WETH ≈ ${fmt(priceBeforeRaw)} ${CONFIG.TOKEN.symbol}`
    );




    // =====================================================
    // APPROVE
    // =====================================================

    await weth.approve(
      CONFIG.V3.ROUTER,
      amountIn
    );




    // =====================================================
    // SWAP EVENT
    // =====================================================

    section("🚀 Creating swap event");



    const tx =
      await router.exactInputSingle({

        tokenIn: CONFIG.WETH,

        tokenOut: CONFIG.TOKEN.address,

        fee: bestFee,

        recipient: trader.address,

        deadline:
          BigInt(
            Math.floor(Date.now() / 1000) + 600
          ),

        amountIn,

        amountOutMinimum: 0n,

        sqrtPriceLimitX96: 0n

      });



    const receipt =
      await tx.wait();



    console.log(
      "TX:",
      receipt.hash
    );


    console.log(
      "Block:",
      receipt.blockNumber
    );


    console.log(
      "Logs:",
      receipt.logs.length
    );



    // =====================================================
    // WAIT FOR BOT
    // =====================================================

    console.log(
      "Waiting 5000ms for bot..."
    );


    await new Promise(resolve =>
      setTimeout(resolve, 5000)
    );

    // =====================================================
    // AFTER
    // =====================================================

    const postOut =
      await quoter.quoteExactInputSingle.staticCall(
        CONFIG.WETH,
        CONFIG.TOKEN.address,
        bestFee,
        amountIn,
        0
      );

    const priceAfterRaw =
      price(
        postOut,
        amountIn
      );

    console.log("\n💲 EXECUTION PRICE (AFTER)");

    console.log(
      `1 WETH ≈ ${fmt(priceAfterRaw)} ${CONFIG.TOKEN.symbol}`
    );

    const move =
      pct(
        priceBeforeRaw,
        priceAfterRaw
      );

    console.log("\n📊 PRICE MOVEMENT");

    console.log(
      move.toFixed(6),
      "%"
    );

    section("✅ BOT EVENT CREATED");

    console.log(
      "Direction:",
      "WETH →",
      CONFIG.TOKEN.symbol
    );

    console.log(
      "AmountIn:",
      ethers.formatEther(amountIn),
      "WETH"
    );

    console.log(
      "Fee:",
      bestFee
    );

    console.log("\n📊 SIGNAL DATA");

    console.log(
      "PrePrice :",
      fmt(priceBeforeRaw)
    );

    console.log(
      "PostPrice:",
      fmt(priceAfterRaw)
    );

    console.log(
      "Move     :",
      move.toFixed(6),
      "%"
    );
  } finally {


    // =====================================================
    // RESTORE POOL STATE
    // =====================================================

    const reverted =
      await ethers.provider.send(
        "evm_revert",
        [snapshot]
      );

    console.log(
      "\nPool state restored:",
      reverted
    );
  }
}
main().catch(console.error);