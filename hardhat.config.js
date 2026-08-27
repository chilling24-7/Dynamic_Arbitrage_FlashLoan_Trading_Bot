require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

/**
 * MEV / Arbitrage Dev Config (Arbitrum Fork)
 * - Live Arbitrum state
 * - No block pinning
 * - Compatible with V3 / flash loan testing
 */

const ARB_RPC = `https://arb-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`;

module.exports = {
  solidity: {
    version: "0.8.18",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },

  networks: {
    // =====================================================
    // 🧪 ARBITRUM MAINNET FORK (PRIMARY TEST ENV)
    // =====================================================
    hardhat: {
      chainId: 31337,

      forking: {
        url: ARB_RPC,
        
        blockNumber: 474400000,
      },

      mining: {
        auto: true,
      },
    },

    // =====================================================
    // LOCAL NODE (optional manual testing)
    // =====================================================
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },
  },
};