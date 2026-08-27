const { ethers } = require("ethers");
require("dotenv").config();
const config = require("../config.json");

// ============================================================
// COLORS
// ============================================================
const ORANGE = "\x1b[38;5;208m";
const RESET = "\x1b[0m";

// ============================================================
// ABIs
// ============================================================
const IERC20 = require("@openzeppelin/contracts/build/contracts/ERC20.json");
const IArbitrage = require("../artifacts/contracts/Arbitrage.sol/Arbitrage.json");

const IUniswapV3Router = require("./SwapRouter.json");
const IUniswapV3Factory = require("@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json");

// ============================================================
// V3 QUOTER ABI (FIXED - CRITICAL)
// ============================================================
const QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn,address tokenOut,uint24 fee,uint256 amountIn,uint160 sqrtPriceLimitX96) external view returns (uint256 amountOut)",
  "function quoteExactInput(bytes path,uint256 amountIn) external view returns (uint256 amountOut)"
];

// ============================================================
// PROVIDER
// ============================================================
let provider;
let isLocal = config.PROJECT_SETTINGS.isLocal;

function initContracts(activeProvider) {

  provider = activeProvider;

  uniV3Router = makeContract(
    config.UNISWAP_V3.ROUTER_ADDRESS,
    IUniswapV3Router.abi || IUniswapV3Router,
    "UNI Router"
  );

  uniV3Quoter = new ethers.Contract(
    config.UNISWAP_V3.QUOTER_ADDRESS,
    QUOTER_ABI,
    provider
  );

  uniV3Factory = makeContract(
    config.UNISWAP_V3.FACTORY_ADDRESS,
    IUniswapV3Factory.abi || IUniswapV3Factory,
    "UNI Factory"
  );

  arbitrage = makeContract(
    config.PROJECT_SETTINGS.ARBITRAGE_ADDRESS,
    IArbitrage.abi || IArbitrage,
    "ARB"
  );

  WETH = makeContract(
    config.PROJECT_SETTINGS.WETH_ADDRESS,
    IERC20.abi || IERC20,
    "WETH"
  );

  USDC = makeContract(
    config.TOKENS.USDC,
    IERC20.abi || IERC20,
    "USDC"
  );
}

// ============================================================
// INIT CHECK
// ============================================================
async function getCode(address) {
  return await provider.getCode(address);
}

async function init() {
  const routerAddr = config.UNISWAP_V3.ROUTER_ADDRESS;

  const code = await getCode(routerAddr);
  const block = await provider.getBlockNumber();

  if (!code || code === "0x") {console.log("FACTORY ABI METHODS:");
    console.log(
      Object.keys(uniV3Factory.interface?.functions || {})
    );
        throw new Error("Uniswap router not found");
        console.log("FACTORY ABI METHODS:");
    console.log(
      Object.keys(uniV3Factory.interface?.functions || {})
    );
  }

  const network = await provider.getNetwork();
  const quoterBlock = await provider.getBlockNumber();
  const factoryBlock = await provider.getBlockNumber();

  console.log(
    ORANGE +
    "\n════════════════════ INIT STATUS ════════════════════" +
    RESET +
    "\n" +
    "✔ Execution Mode : " +
    (config.PROJECT_SETTINGS.isLocal ? "LOCAL FORK" : "LIVE ARBITRUM") +
    "\n" +
    "✔ Source Chain   : Arbitrum One" +
    "\n" +
    "✔ Chain ID       : " +
    network.chainId.toString() +
    "\n" +
    "✔ Network block  : " +
    block +
    "\n" +
    "✔ Router (Uniswap): OK" +
    "\n" +
    "✔ Address        : " +
    routerAddr +
    "\n" +
    "✔ Code size      : " +
    code.length +
    "\n" +
    "✔ Quoter Block   : " +
    quoterBlock +
    "\n" +
    "✔ Factory Block  : " +
    factoryBlock +
    "\n" +
    "✔ Quoter Address : " +
    uniV3Quoter.target +
    "\n" +
    "✔ Factory Address: " +
    uniV3Factory.target +
    "\n" +
    ORANGE +
    "═════════════════════════════════════════════════════" +
    RESET
  );
}

// ============================================================
// BOOTSTRAP
// ============================================================
let INIT_READY = false;

async function bootstrap() {
  await init();
  INIT_READY = true;
}

// ============================================================
// CONTRACT FACTORY
// ============================================================
function makeContract(address, abi, name) {
  if (!address) throw new Error(`Missing ${name}`);
  if (!Array.isArray(abi)) throw new Error(`Bad ABI ${name}`);

  return new ethers.Contract(address, abi, provider);
}

let uniV3Router;
let uniV3Quoter;
let uniV3Factory;

let arbitrage;
let WETH;
let USDC;

// ============================================================
// EXPORTS
// ============================================================
module.exports = {
  init,
  initContracts,
  getProvider: () => provider,

  get uniV3Router(){
    return uniV3Router;
  },

  get uniV3Quoter(){
    return uniV3Quoter;
  },

  get uniV3Factory(){
    return uniV3Factory;
  },

  get arbitrage(){
    return arbitrage;
  },

  get WETH(){
    return WETH;
  },

  get USDC(){
    return USDC;
  }
};