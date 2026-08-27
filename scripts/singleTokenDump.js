/**
 * Generic Token Dump Test
 * Ethers v6 + BigInt safe
 */

const hre=require("hardhat");
const {ethers}=hre;

const CONFIG={
  TOKEN:{
    symbol:"LINK",
    address:"0xf97f4df75117a78c1a5a0dbb814af92458539fb4"
  },
  WETH:"0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
  V3:{
    QUOTER:"0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
    ROUTER:"0xE592427A0AEce92De3Edee1F18E0157C05861564"
  },
  FEES:[500,3000,10000],

  // small dump size
  DUMP_LINK:"1000",
};

const ERC20_ABI=[
  "function decimals() view returns(uint8)",
  "function balanceOf(address) view returns(uint256)",
  "function approve(address,uint256) returns(bool)",
  "function transfer(address,uint256) returns(bool)"
];

const QUOTER_ABI=[
  "function quoteExactInputSingle(address,address,uint24,uint256,uint160) returns(uint256)"
];

const ROUTER_ABI=[
  "function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns(uint256)"
];

const section=x=>{
  console.log("\n═══════════════════════════════");
  console.log(x);
  console.log("═══════════════════════════════");
};

const price=(out,inAmt)=>{
  if(inAmt===0n)return 0n;
  return(out*10n**18n)/inAmt;
};

const pct=(before,after)=>{
  return Number(((after-before)*10000n)/before)/100;
};

const fmt=x=>Number(x)/1e18;


async function fundToken(token,from,to,amount){

  if(!from)
    throw new Error("Missing token whale");

  await hre.network.provider.request({
    method:"hardhat_impersonateAccount",
    params:[from]
  });

  const whale=await ethers.getSigner(from);

  await token
    .connect(whale)
    .transfer(to,amount);

  await hre.network.provider.request({
    method:"hardhat_stopImpersonatingAccount",
    params:[from]
  });
}


async function findBestFee(
  quoter,
  tokenIn,
  tokenOut,
  amountIn,
  outDecimals
){

  let bestFee=null;
  let bestOut=0n;

  for(const fee of CONFIG.FEES){

    try{

      const out=
        await quoter.quoteExactInputSingle.staticCall(
          tokenIn,
          tokenOut,
          fee,
          amountIn,
          0
        );

      console.log(
        fee,
        ethers.formatUnits(out,outDecimals)
      );

      if(out>bestOut){
        bestOut=out;
        bestFee=fee;
      }

    }catch{}

  }

  if(!bestFee)
    throw new Error("No valid pool");

  return{
    fee:bestFee,
    out:bestOut
  };
}


async function swap(
  router,
  tokenIn,
  tokenOut,
  fee,
  amountIn,
  recipient
){

  const tx=
    await router.exactInputSingle({
      tokenIn,
      tokenOut,
      fee,
      recipient,
      deadline:BigInt(Math.floor(Date.now()/1000)+600),
      amountIn,
      amountOutMinimum:0n,
      sqrtPriceLimitX96:0n
    });

  return await tx.wait();
}


async function main(){

  const [trader]=await ethers.getSigners();

  const token=
    await ethers.getContractAt(
      ERC20_ABI,
      CONFIG.TOKEN.address
    );

  const quoter=
    await ethers.getContractAt(
      QUOTER_ABI,
      CONFIG.V3.QUOTER
    );

  const router=
    await ethers.getContractAt(
      ROUTER_ABI,
      CONFIG.V3.ROUTER,
      trader
    );

  const decimals=
    await token.decimals();

  const balance = await token.balanceOf(trader.address);

  if(balance === 0n){
    throw new Error("No LINK balance. Run pump test first.");
  }

  const amountIn = balance / 10n;

  console.log(
    "Using LINK:",
    ethers.formatUnits(amountIn,decimals)
  );


  console.log(
    "Funded:",
    ethers.formatUnits(amountIn,decimals),
    CONFIG.TOKEN.symbol
  );


  section(`🧪 V3 DUMP EVENT ${CONFIG.TOKEN.symbol}`);


  console.log(
    "Trader:",
    trader.address
  );

  console.log(
    "Direction:",
    `${CONFIG.TOKEN.symbol} → WETH`
  );

  console.log(
    "Amount:",
    ethers.formatUnits(amountIn,decimals),
    CONFIG.TOKEN.symbol
  );

    console.log("\nChecking dump fee tiers");


  const dumpQuote=
    await findBestFee(
      quoter,
      CONFIG.TOKEN.address,
      CONFIG.WETH,
      amountIn,
      18
    );


  const priceBeforeRaw=
    price(
      dumpQuote.out,
      amountIn
    );


  console.log("\n💲 EXECUTION PRICE (BEFORE)");

  console.log(
    `1 ${CONFIG.TOKEN.symbol} ≈ ${fmt(priceBeforeRaw)} WETH`
  );


  await token.approve(
    CONFIG.V3.ROUTER,
    amountIn
  );


  section("🚀 Creating dump swap");


  const receipt=
    await swap(
      router,
      CONFIG.TOKEN.address,
      CONFIG.WETH,
      dumpQuote.fee,
      amountIn,
      trader.address
    );


  console.log(
    "TX:",
    receipt.hash
  );


  const postOut=
    await quoter.quoteExactInputSingle.staticCall(
      CONFIG.TOKEN.address,
      CONFIG.WETH,
      dumpQuote.fee,
      amountIn,
      0
    );


  const priceAfterRaw=
    price(
      postOut,
      amountIn
    );


  console.log("\n💲 EXECUTION PRICE (AFTER)");

  console.log(
    `1 ${CONFIG.TOKEN.symbol} ≈ ${fmt(priceAfterRaw)} WETH`
  );


  const move=
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
    `${CONFIG.TOKEN.symbol} → WETH`
  );


  console.log(
    "AmountIn:",
    ethers.formatUnits(
      amountIn,
      decimals
    ),
    CONFIG.TOKEN.symbol
  );


  console.log(
    "Fee:",
    dumpQuote.fee
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
}


main().catch(console.error);