# 📊 CoinGlass BTC Analyzer with AI

A real-time React web application that displays BTC market data from CoinGlass API with AI-powered price predictions and analysis using ChatGPT.

## Features

- **Real-time BTC Market Data**
  - Current BTC price
  - Liquidation levels (above/below)
  - Open Interest (OI)
  - Funding Rate
  - Long/Short Ratio

- **AI Price Predictions**
  - Automated AI analysis of current market data
  - Confidence level assessment
  - Trend predictions

- **ChatGPT Integration**
  - Interactive chat interface with ChatGPT
  - Real-time market context in responses
  - Ask questions about price movements, liquidations, and market sentiment
  - Full conversation history within session

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

### 2. Add API Keys

Create a `.env` file in the project root with your API keys:

```
VITE_COINGLASS_API_KEY=your_coinglass_hobbyist_api_key_here
VITE_OPENAI_API_KEY=your_openai_api_key_here
```

#### Getting API Keys

**CoinGlass API:**
1. Visit [CoinGlass](https://www.coinglass.com/)
2. Sign up for a free account
3. Navigate to API settings in your dashboard
4. Copy your Hobbyist API key

**OpenAI API:**
1. Visit [OpenAI Platform](https://platform.openai.com/)
2. Create an account or sign in
3. Go to API keys section
4. Create a new API key
5. Copy and paste it in `.env`

### 3. Start Development Server

```bash
npm run dev
```

The app will be available at `http://localhost:5173`

## Usage

### Market Data Panel
- Displays real-time BTC price and liquidation levels
- Shows Open Interest, Funding Rate, and Long/Short Ratio
- Auto-refreshes every 30 seconds (can be toggled)
- Click "Refresh Now" for immediate updates

### AI Prediction Panel
- Click "Refresh Prediction" to get AI analysis
- ChatGPT analyzes current market data and provides price predictions
- Shows confidence levels and trend analysis

### Chat Interface
- Ask any questions about BTC market
- ChatGPT provides context-aware responses with current market data
- View full conversation history in the chat window
- Type and press Enter or click send button

## Project Structure

```
src/
├── components/
│   ├── DataDisplay.tsx        # Market data visualization
│   ├── AIPredictionPanel.tsx  # AI prediction component
│   └── ChatInterface.tsx      # ChatGPT chat interface
├── services/
│   ├── coinglass.ts          # CoinGlass API integration
│   └── openai.ts             # OpenAI/ChatGPT integration
├── styles/
│   ├── DataDisplay.css
│   ├── AIPredictionPanel.css
│   └── ChatInterface.css
├── App.tsx                    # Main application
└── index.css                  # Global styles
```

## API Integration Details

### CoinGlass API
- Hobbyist tier endpoints for BTC data
- Fetches: Price, Liquidations, Open Interest, Funding Rate, Long/Short Ratio
- Requests are cached and refreshed every 30 seconds (configurable)

### OpenAI API
- GPT-3.5 Turbo model for reliable responses and analysis
- Sends current market context in system message
- Maintains conversation history for better context

## Environment Variables

```env
# CoinGlass API Configuration
VITE_COINGLASS_API_KEY=your_key_here

# OpenAI API Configuration
VITE_OPENAI_API_KEY=your_key_here
```

## Build for Production

```bash
npm run build
```

Output will be in the `dist/` directory.

## Tech Stack

- **Frontend**: React 18 + TypeScript
- **Build Tool**: Vite
- **Styling**: CSS3 with modern gradients and animations
- **HTTP Client**: Axios
- **APIs**: CoinGlass (market data), OpenAI (AI predictions)

## Features Coming Soon

- Historical price charts
- Custom liquidation level alerts
- Funding rate trends
- Portfolio tracking
- Multi-pair analysis
- Advanced trading signals

## Troubleshooting

**"Failed to fetch BTC data"**
- Check that your CoinGlass API key is correctly entered in `.env`
- Verify your internet connection
- Check API rate limits

**"ChatGPT not responding"**
- Verify OpenAI API key is correctly set
- Check your OpenAI account has available credits
- Look for API error messages in browser console

**Port already in use**
- Run: `npm run dev -- --port 3000`

## Security Notes

- Never commit your `.env` file with real API keys
- Keep API keys confidential
- The app only sends requests to official CoinGlass and OpenAI APIs
- No data is stored on external servers beyond API calls

## License

MIT

## Support

For issues or questions:
1. Check the `.env` file is properly configured
2. Verify API keys are valid and have active subscriptions
3. Review browser console for error messages
4. Check API documentation for rate limits

---

**Happy trading! 🚀**
