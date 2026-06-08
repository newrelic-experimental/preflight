export type BannerTheme = 'observatory' | 'sessions' | 'history' | 'audit' | 'git';

export function GeoBanner({ theme = 'observatory' }: { theme?: BannerTheme }): JSX.Element {
  return (
    <div className="geo-banner" aria-hidden="true">
      {theme === 'observatory' && <ObservatoryBanner />}
      {theme === 'sessions' && <SessionsBanner />}
      {theme === 'history' && <HistoryBanner />}
      {theme === 'audit' && <AuditBanner />}
      {theme === 'git' && <GitBanner />}
    </div>
  );
}

function ObservatoryBanner(): JSX.Element {
  return (
    <svg viewBox="0 0 800 80" preserveAspectRatio="xMidYMid slice" className="w-full h-full">
      {/* Sunset sky gradient */}
      <defs>
        <linearGradient id="obsSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1a3a5c" />
          <stop offset="40%" stopColor="#2d5a7b" />
          <stop offset="70%" stopColor="#e8834a" />
          <stop offset="100%" stopColor="#f4a261" />
        </linearGradient>
      </defs>
      <rect width="800" height="80" fill="url(#obsSky)" />
      {/* Mountain range - back */}
      <polygon
        points="0,80 0,45 80,38 160,48 240,30 340,42 420,25 500,38 580,32 660,40 740,28 800,35 800,80"
        fill="#1a3a5c"
        opacity="0.7"
      />
      {/* Mountains - mid */}
      <polygon
        points="0,80 0,55 60,48 140,58 220,42 300,52 380,40 460,50 520,38 600,48 680,42 760,52 800,48 800,80"
        fill="#234e6f"
      />
      {/* Foreground hills with green */}
      <polygon
        points="0,80 0,62 100,58 200,65 300,55 400,60 500,54 600,62 700,56 800,60 800,80"
        fill="#2a6b4a"
        opacity="0.8"
      />
      {/* Warm sun glow */}
      <circle cx="680" cy="28" r="14" fill="#f4a261" opacity="0.6" />
      <circle cx="680" cy="28" r="8" fill="#ffd166" opacity="0.5" />
      {/* Observatory silhouette */}
      <ellipse cx="150" cy="56" rx="18" ry="10" fill="#1a3a5c" />
      <line x1="150" y1="46" x2="172" y2="34" stroke="#5ce0d8" strokeWidth="1.5" opacity="0.8" />
    </svg>
  );
}

function SessionsBanner(): JSX.Element {
  return (
    <svg viewBox="0 0 800 80" preserveAspectRatio="xMidYMid slice" className="w-full h-full">
      {/* Coastal cliffs with waterfall */}
      <defs>
        <linearGradient id="seaSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#4aa8c7" />
          <stop offset="60%" stopColor="#3a8fb7" />
          <stop offset="100%" stopColor="#2d7a9e" />
        </linearGradient>
      </defs>
      <rect width="800" height="80" fill="url(#seaSky)" />
      {/* Distant islands */}
      <polygon points="600,48 640,35 680,48" fill="#2d7a4a" opacity="0.4" />
      <polygon points="700,50 730,40 760,50" fill="#3d9b5b" opacity="0.3" />
      {/* Left cliff face - warm orange/coral rock */}
      <polygon points="0,80 0,15 40,12 80,20 120,18 160,25 180,30 180,80" fill="#c05a3c" />
      <polygon
        points="0,80 0,25 30,22 60,28 100,25 140,30 160,35 160,80"
        fill="#e8834a"
        opacity="0.6"
      />
      {/* Vegetation on cliffs */}
      <polygon points="20,20 35,8 50,20" fill="#3d9b5b" />
      <polygon points="60,22 72,12 84,24" fill="#4aad6b" />
      <polygon points="100,20 115,10 130,22" fill="#3d9b5b" />
      <polygon points="140,28 150,18 160,28" fill="#4aad6b" opacity="0.8" />
      {/* Waterfall */}
      <rect x="120" y="30" width="8" height="50" fill="#87ceeb" opacity="0.5" />
      <rect x="122" y="30" width="4" height="50" fill="#fff" opacity="0.3" />
      {/* Right cliff */}
      <polygon
        points="620,80 620,30 660,25 700,32 740,28 780,35 800,30 800,80"
        fill="#c05a3c"
        opacity="0.8"
      />
      <polygon points="650,30 665,18 680,30" fill="#3d9b5b" />
      <polygon points="720,32 732,22 744,32" fill="#4aad6b" />
      {/* Ocean surface */}
      <polygon
        points="180,80 180,55 250,52 350,56 450,52 550,55 620,52 620,80"
        fill="#2d7a9e"
        opacity="0.6"
      />
      <line x1="200" y1="60" x2="280" y2="58" stroke="#5ce0d8" strokeWidth="0.8" opacity="0.3" />
      <line x1="350" y1="56" x2="450" y2="55" stroke="#5ce0d8" strokeWidth="0.8" opacity="0.25" />
      <line x1="480" y1="58" x2="580" y2="56" stroke="#87ceeb" strokeWidth="0.8" opacity="0.3" />
    </svg>
  );
}

function HistoryBanner(): JSX.Element {
  return (
    <svg viewBox="0 0 800 80" preserveAspectRatio="xMidYMid slice" className="w-full h-full">
      {/* Futuristic road scene like the ebook illustration */}
      <defs>
        <linearGradient id="histSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#3a7ca5" />
          <stop offset="60%" stopColor="#5bb8d4" />
          <stop offset="100%" stopColor="#8ed4c0" />
        </linearGradient>
      </defs>
      <rect width="800" height="80" fill="url(#histSky)" />
      {/* Distant geometric mountains/structures */}
      <polygon points="100,50 140,20 180,50" fill="#e8834a" opacity="0.7" />
      <polygon points="160,50 210,15 260,50" fill="#d4694a" opacity="0.6" />
      <polygon points="550,50 600,18 650,50" fill="#e8834a" opacity="0.6" />
      <polygon points="620,50 660,22 700,50" fill="#c05a3c" opacity="0.5" />
      {/* Geometric crystal structures */}
      <polygon points="350,50 370,12 390,50" fill="#5ce0d8" opacity="0.4" />
      <polygon points="380,50 395,20 410,50" fill="#87ceeb" opacity="0.3" />
      <polygon points="700,50 715,25 730,50" fill="#5ce0d8" opacity="0.35" />
      {/* Road/path */}
      <polygon points="300,80 380,50 420,50 500,80" fill="#2a5a6b" opacity="0.6" />
      <line x1="390" y1="52" x2="350" y2="78" stroke="#f4a261" strokeWidth="1" opacity="0.4" />
      <line x1="410" y1="52" x2="450" y2="78" stroke="#f4a261" strokeWidth="1" opacity="0.4" />
      {/* Foreground - green terrain */}
      <polygon
        points="0,80 0,55 80,52 160,58 240,50 320,55 500,52 580,56 660,50 740,55 800,52 800,80"
        fill="#2d8a4a"
        opacity="0.5"
      />
      <polygon
        points="0,80 0,65 60,62 140,68 220,60 400,65 500,62 600,66 700,60 800,65 800,80"
        fill="#1e6b3a"
        opacity="0.6"
      />
      {/* Trees */}
      <polygon points="30,65 42,42 54,65" fill="#3d9b5b" opacity="0.8" />
      <polygon points="50,65 60,48 70,65" fill="#2d8a4a" opacity="0.7" />
      <polygon points="720,65 732,45 744,65" fill="#3d9b5b" opacity="0.7" />
      <polygon points="760,65 770,50 780,65" fill="#2d8a4a" opacity="0.8" />
    </svg>
  );
}

function AuditBanner(): JSX.Element {
  return (
    <svg viewBox="0 0 800 80" preserveAspectRatio="xMidYMid slice" className="w-full h-full">
      {/* Forest with light filtering through */}
      <defs>
        <linearGradient id="auditSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1a5c3a" />
          <stop offset="50%" stopColor="#2d7a4a" />
          <stop offset="100%" stopColor="#3d9b5b" />
        </linearGradient>
      </defs>
      <rect width="800" height="80" fill="url(#auditSky)" />
      {/* Light rays through canopy */}
      <polygon points="200,0 210,80 220,0" fill="#ffd166" opacity="0.08" />
      <polygon points="500,0 510,80 520,0" fill="#ffd166" opacity="0.06" />
      <polygon points="650,0 660,80 670,0" fill="#fff" opacity="0.05" />
      {/* Tree trunks */}
      <rect x="80" y="20" width="6" height="60" fill="#1a4a2e" />
      <rect x="180" y="10" width="7" height="70" fill="#1a4a2e" />
      <rect x="320" y="15" width="6" height="65" fill="#1a4a2e" />
      <rect x="500" y="8" width="7" height="72" fill="#1a4a2e" />
      <rect x="620" y="18" width="6" height="62" fill="#1a4a2e" />
      <rect x="740" y="12" width="7" height="68" fill="#1a4a2e" />
      {/* Canopy - layered greens */}
      <polygon points="55,25 83,5 111,25" fill="#4aad6b" />
      <polygon points="60,35 83,15 106,35" fill="#3d9b5b" />
      <polygon points="155,15 183,0 211,18" fill="#5bc47a" />
      <polygon points="160,28 183,8 206,28" fill="#4aad6b" />
      <polygon points="295,20 323,2 351,22" fill="#5bc47a" />
      <polygon points="300,32 323,12 346,32" fill="#3d9b5b" />
      <polygon points="475,12 503,0 531,15" fill="#4aad6b" />
      <polygon points="480,25 503,5 526,25" fill="#3d9b5b" />
      <polygon points="595,22 623,5 651,22" fill="#5bc47a" />
      <polygon points="600,34 623,14 646,34" fill="#4aad6b" />
      <polygon points="715,16 743,0 771,18" fill="#5bc47a" />
      <polygon points="720,30 743,10 766,30" fill="#3d9b5b" />
      {/* Ground layer with warm earth */}
      <polygon
        points="0,80 0,68 100,65 200,70 300,64 400,68 500,63 600,67 700,64 800,68 800,80"
        fill="#1e6b3a"
      />
      {/* Orange/coral crystals on ground */}
      <polygon points="250,80 258,65 266,80" fill="#e8834a" opacity="0.6" />
      <polygon points="450,80 456,68 462,80" fill="#f4a261" opacity="0.5" />
      <polygon points="650,80 656,66 662,80" fill="#e8834a" opacity="0.55" />
    </svg>
  );
}

function GitBanner(): JSX.Element {
  return (
    <svg viewBox="0 0 800 80" preserveAspectRatio="xMidYMid slice" className="w-full h-full">
      {/* River valley with branching streams */}
      <defs>
        <linearGradient id="gitSky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#2d5a7b" />
          <stop offset="60%" stopColor="#3a8fb7" />
          <stop offset="100%" stopColor="#5bb8d4" />
        </linearGradient>
      </defs>
      <rect width="800" height="80" fill="url(#gitSky)" />
      {/* Valley walls */}
      <polygon
        points="0,80 0,20 60,25 120,18 180,28 220,22 260,30 260,80"
        fill="#2d7a4a"
        opacity="0.7"
      />
      <polygon
        points="540,80 540,22 600,28 660,20 720,25 780,18 800,22 800,80"
        fill="#2d7a4a"
        opacity="0.7"
      />
      {/* River - main branch */}
      <path
        d="M 260,50 Q 320,48 400,45 Q 480,42 540,50"
        fill="none"
        stroke="#5ce0d8"
        strokeWidth="4"
        opacity="0.5"
      />
      {/* Branching streams */}
      <path
        d="M 350,45 Q 370,35 400,28"
        fill="none"
        stroke="#87ceeb"
        strokeWidth="2"
        opacity="0.4"
      />
      <path
        d="M 420,44 Q 440,52 470,60"
        fill="none"
        stroke="#87ceeb"
        strokeWidth="2"
        opacity="0.4"
      />
      <path
        d="M 400,28 Q 430,25 460,30"
        fill="none"
        stroke="#5ce0d8"
        strokeWidth="1.5"
        opacity="0.35"
      />
      {/* Merge point */}
      <circle cx="400" cy="45" r="3" fill="#5ce0d8" opacity="0.6" />
      <circle cx="350" cy="45" r="2" fill="#1ce783" opacity="0.5" />
      <circle cx="460" cy="44" r="2" fill="#1ce783" opacity="0.5" />
      {/* Rocks/boulders */}
      <polygon points="300,65 310,55 320,65" fill="#3a6b4a" opacity="0.6" />
      <polygon points="480,62 492,52 504,62" fill="#3a6b4a" opacity="0.6" />
      {/* Trees along banks */}
      <polygon points="240,35 250,18 260,35" fill="#4aad6b" />
      <polygon points="540,35 550,20 560,35" fill="#4aad6b" />
      <polygon points="270,50 278,38 286,50" fill="#3d9b5b" opacity="0.8" />
      <polygon points="520,48 528,36 536,48" fill="#3d9b5b" opacity="0.8" />
    </svg>
  );
}
