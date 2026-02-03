<div align="center">

# CinePro Core 🎬

**OMSS-compliant streaming backend powering the CinePro ecosystem.**</br> Built with [@omss/framework](https://www.npmjs.com/package/@omss/framework) for extensible, type-safe media scraping and streaming.

</div>

---

## Overview

CinePro Core is the foundational backend service of CinePro that uses the Open Media Streaming Standard (OMSS) for movies and TV shows. This repository serves as the central scraping and streaming engine, designed to work seamlessly with the [CinePro ecosystem](https://github.com/orgs/cinepro-org/repositories?type=source).

Built on the [OMSS template](https://github.com/omss-spec/template), this backend implements a modular provider system that enables easy integration of multiple streaming sources (that means providers) while maintaining type safety and production-ready standards.

---

## ✨ Features

- 🎯 **OMSS-Compliant** – Follows the Open Media Streaming Standard specification
- 🔌 **Modular Providers** – Drop-in provider system with auto-discovery
- 🛡️ **Type-Safe** – Full TypeScript implementation with strict types
- ⚡ **Production-Ready** – Redis caching, Docker support, error handling
- 🎬 **Multi-Source** – Support for movies and TV shows from multiple providers
- 🔄 **Hot Reload** – Development mode with automatic restarts
- 📦 **CineHome Integration** – Compatible with CineHome download automation and any other CinePro ecosystem products

---

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- TMDB API Key ([get one here](https://www.themoviedb.org/settings/api))

### Installation

```bash
# Clone the repository
git clone https://github.com/cinepro-org/core.git
cd core

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env and add your TMDB_API_KEY
```

### Development

```bash
# Start dev server with hot reload
npm run dev

# Server runs at http://localhost:3000
```

### Production

> [!Caution]
> **CinePro Core is designed for personal and home use only.**
> </br> Users are responsible for ensuring compliance with applicable laws and terms of service for streaming sources.

```bash
# Modify .env to match your environment (maybe redis)
cp .env.example .env

# Build and start
npm run build
npm start
```

---

## 📁 Project Structure

```
core/
├── src/
│   ├── server.ts           # Main server entrypoint
│   ├── providers/          # Streaming source providers
│   │   └── example.ts      # Reference implementation
├── .env.example            # Environment configuration template
├── package.json            # Dependencies and scripts
└── tsconfig.json           # TypeScript configuration
```

---

## 🔌 Adding Providers

CinePro Core uses an extensible provider system. Each provider implements the `BaseProvider` interface to supply streaming sources.

### Create a New Provider

```typescript
// src/providers/mysite.ts
import { BaseProvider } from '@omss/framework';

export class MySiteProvider extends BaseProvider {
    readonly id = 'mysite';
    readonly name = 'My Streaming Site';
    readonly BASE_URL = 'https://mysite.com';
    readonly capabilities = { 
        supportedContentTypes: ['movies', 'tv'] 
    };

    async getMovieSources(tmdbId: string) {
        // Implementation
    }

    async getTVSources(tmdbId: string, season: number, episode: number) {
        // Implementation
    }
}
```

### Auto-Discovery

Place your provider in `src/providers/` and restart the server. The framework automatically discovers and registers new providers.

---

## ⚙️ Configuration

### Environment Variables

Create a `.env` file based on `.env.example`:

```env
# Required
TMDB_API_KEY=your_tmdb_api_key_here

# Server Configuration
PORT=3000
HOST=localhost
NODE_ENV=development
PUBLIC_URL=http://localhost:3000

# Redis (Production)
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

### TMDB API Key

CinePro Core requires a TMDB API key for metadata enrichment:

1. Create a TMDB account at [themoviedb.org](https://www.themoviedb.org/)
2. Navigate to Settings → API
3. Request an API key (choose "Developer" option)
4. Add the key to your `.env` file

---

## 🛠️ Development

### Scripts

```bash
npm run dev      # Development server with hot reload
npm run build    # Build for production
npm start        # Start production server. Requires build first
npm run format   # Format code with Prettier
```

### Code Standards

- TypeScript strict mode enabled
- Prettier for code formatting
- Comprehensive error handling
- Provider interface compliance

---

## 📚 Documentation

- **OMSS Specification**: [github.com/omss-spec/omss-spec](https://github.com/omss-spec/omss-spec)
- **Framework Docs**: [@omss/framework on npm](https://www.npmjs.com/package/@omss/framework)
- **CinePro Docs**: [cinepro.mintlify.app](https://cinepro.mintlify.app)

---

## 🤝 Contributing

CinePro is actively maintained and open to contributors. We welcome: [github](https://github.com/cinepro-org)

- New provider implementations
- Bug fixes and improvements
- Documentation enhancements
- Performance optimizations

### How to Contribute

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-provider`)
3. Commit your changes (`git commit -m 'Add amazing provider'`)
4. Push to the branch (`git push origin feature/amazing-provider`)
5. Open a Pull Request

See [CONTRIBUTING.md](https://github.com/omss-spec/omss-spec/blob/main/CONTRIBUTING.md) for detailed guidelines.

---

## 🔒 Legal Notice

CinePro Core is designed for **personal and home use only**. Users are responsible for ensuring compliance with applicable laws and terms of service for streaming sources. This software does not host, store, or distribute any copyrighted content. [github](https://github.com/cinepro-org)

---

## 📄 License

MIT © CinePro Organization

---

## 🌟 Acknowledgments

- Built with [OMSS Framework](https://github.com/omss-spec)
- Metadata powered by [The Movie Database (TMDB)](https://www.themoviedb.org/)
- Template from [omss-spec/template](https://github.com/omss-spec/template)

---

<div align="center">

**[Documentation](https://cinepro.mintlify.app)** -  **[Discussions](https://github.com/orgs/cinepro-org/discussions/)** -  **[Report Issue](https://github.com/cinepro-org/core/issues)**

⭐ **Star this repo** if you find it useful!

</div>