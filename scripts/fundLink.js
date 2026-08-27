// Fund Link so test, singleTOkenDump.js will work

const hre=require("hardhat");
const {ethers}=hre;

const CONFIG={
TOKEN:"0xf97f4df75117a78c1a5a0dbb814af92458539fb4",
WETH:"0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
QUOTER:"0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6",
ROUTER:"0xE592427A0AEce92De3Edee1F18E0157C05861564",
FEE:3000,
AMOUNT:"10"
};

const ERC20_ABI=[
"function approve(address,uint256) returns(bool)",
"function balanceOf(address) view returns(uint256)",
"function decimals() view returns(uint8)",
"function deposit() payable"
];

const ROUTER_ABI=[
"function exactInputSingle(tuple(address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) returns(uint256)"
];


async function main(){

const [trader]=await ethers.getSigners();

const weth=
await ethers.getContractAt(
ERC20_ABI,
CONFIG.WETH
);

const token=
await ethers.getContractAt(
ERC20_ABI,
CONFIG.TOKEN
);

const router=
await ethers.getContractAt(
ROUTER_ABI,
CONFIG.ROUTER,
trader
);


const amount=
ethers.parseEther(CONFIG.AMOUNT);


// wrap ETH

await weth.deposit({
value:amount
});


console.log(
"Wrapped WETH:",
ethers.formatEther(amount)
);


// approve

await weth.approve(
CONFIG.ROUTER,
amount
);


// create LINK

const tx=
await router.exactInputSingle({
tokenIn:CONFIG.WETH,
tokenOut:CONFIG.TOKEN,
fee:CONFIG.FEE,
recipient:trader.address,
deadline:BigInt(Math.floor(Date.now()/1000)+600),
amountIn:amount,
amountOutMinimum:0n,
sqrtPriceLimitX96:0n
});


await tx.wait();


const balance=
await token.balanceOf(
trader.address
);


console.log(
"LINK balance:",
ethers.formatUnits(
balance,
await token.decimals()
)
);


console.log(
"Funding complete. Now run dump test."
);

}


main().catch(console.error);