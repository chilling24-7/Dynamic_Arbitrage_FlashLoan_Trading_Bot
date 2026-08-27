// topTokensArbitrum.js
module.exports = [
  { symbol: "WETH", address: "0x82aF49447D8a07e3bd95BD0d56f35241523FBab1".toLowerCase(), decimals: 18 },
  { symbol: "WBTC", address: "0x2f2a2543b76a4166549f7aaB2e75Bef0aefC5B0f".toLowerCase(), decimals: 8 },

  // stablecoins (core MEV liquidity layer)
  { symbol: "USDT", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9".toLowerCase(), decimals: 6 },
  { symbol: "USDC", address: "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8".toLowerCase(), decimals: 6 },
  { symbol: "DAI",  address: "0xda10009cbd5d07dd0cecc66161fc93d7c9000da1".toLowerCase(), decimals: 18 },

  // high liquidity DeFi blue chips
  { symbol: "LINK", address: "0xf97f4df75117a78c1a5a0dbb814af92458539fb4".toLowerCase(), decimals: 18 },
  { symbol: "UNI",  address: "0xfa7f8980b0f1e64a2062791cc3b0871572f1f7f0".toLowerCase(), decimals: 18 },
  { symbol: "AAVE", address: "0x76fb31fb4af56892a25e32cfc43de717950c9278".toLowerCase(), decimals: 18 },
  { symbol: "CRV",  address: "0x11cdb42b0eb46d95f990bedd4695a6e3fa034978".toLowerCase(), decimals: 18 },

  // optional high-volatility tokens (good for inefficiencies)
  { symbol: "SHIB", address: "0x2c0d94c2b2b8e2f28f2a2ed0ce2a4b5d0ed6f6b3".toLowerCase(), decimals: 18 },
  { symbol: "LDO",  address: "0x6f3c0a4c5f7a184bc9242d0a2a12dbbce0d7bbaa".toLowerCase(), decimals: 18 },

  // mid-cap DeFi / opportunistic
  { symbol: "FRAX", address: "0x17fc002b466eec40dae837fc4be5c67993ddbd6f".toLowerCase(), decimals: 18 },
  { symbol: "FXS",  address: "0x1f3e8c0a4b2b3b76c8a14a8a1f0f2c5d1f1f3f5d".toLowerCase(), decimals: 18 },
  { symbol: "LRC",  address: "0xbbbbca6a901c926f240b89eacb641d8aec7aeafd".toLowerCase(), decimals: 18 },
  { symbol: "1INCH", address: "0x111111111117dc0aa78b770fa6a738034120c302".toLowerCase(), decimals: 18 },

  // higher risk / optional alpha
  { symbol: "DYDX", address: "0x92d6c1e31e14520e676a687f0a93788b716beff5".toLowerCase(), decimals: 18 },
  { symbol: "RPL",  address: "0xd33526068d116ce69f19a9ee46f0bd304f21a51f".toLowerCase(), decimals: 18 },
  { symbol: "MKR",  address: "0x5efda50b314c9a3a351bd4bcd93c00f2d699f52b".toLowerCase(), decimals: 18 }
];