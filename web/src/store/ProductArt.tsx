// Line illustrations for the catalog, so the stores need no external images.
const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

function Jacket() {
  return (
    <g {...common}>
      <path d="M78 34 L100 44 L122 34 L146 46 L164 104 L148 110 L140 84 L140 140 L60 140 L60 84 L52 110 L36 104 L54 46 Z" />
      <path d="M100 44 L100 140" />
      <path d="M86 32 Q100 22 114 32" />
      <path d="M60 64 H140 M60 84 H140 M60 104 H140 M60 124 H140" strokeOpacity=".55" />
      <path d="M41 88 L57 82 M46 102 L60 96 M159 88 L143 82 M154 102 L140 96" strokeOpacity=".55" />
      <circle cx="108" cy="58" r="2" fill="currentColor" />
    </g>
  );
}
function Boots() {
  return (
    <g {...common}>
      <path d="M62 30 L104 30 L106 92 Q132 94 152 104 Q166 112 164 124 L164 132 L44 132 L44 118 Q52 104 56 80 Z" />
      <path d="M44 132 L44 142 L164 142 L164 132" />
      <path d="M50 142 v-6 M66 142 v-6 M82 142 v-6 M98 142 v-6 M114 142 v-6 M130 142 v-6 M146 142 v-6" strokeOpacity=".6" />
      <path d="M70 44 L96 40 M70 56 L98 52 M70 68 L100 64 M72 80 L102 76" strokeOpacity=".7" />
      <path d="M106 92 Q102 112 120 118" strokeOpacity=".55" />
      <circle cx="68" cy="44" r="2.4" /><circle cx="68" cy="56" r="2.4" /><circle cx="68" cy="68" r="2.4" />
    </g>
  );
}
function Tent() {
  return (
    <g {...common}>
      <path d="M24 136 L100 34 L176 136 Z" />
      <path d="M100 34 L84 136 M100 34 L118 136" strokeOpacity=".55" />
      <path d="M100 74 L86 136 L114 136 Z" />
      <path d="M100 34 L100 24 M16 136 L184 136" />
      <path d="M24 136 L8 144 M176 136 L192 144" strokeOpacity=".55" />
      <path d="M140 52 l8 -6 M148 64 l8 -4" strokeOpacity=".4" />
    </g>
  );
}
function Beanie() {
  return (
    <g {...common}>
      <path d="M46 110 Q46 40 100 38 Q154 40 154 110" />
      <rect x="40" y="104" width="120" height="30" rx="8" />
      <path d="M56 104 v30 M72 104 v30 M88 104 v30 M104 104 v30 M120 104 v30 M136 104 v30 M152 104 v30" strokeOpacity=".5" />
      <path d="M66 98 Q70 62 92 46 M100 96 Q100 60 106 42 M134 98 Q130 62 114 46" strokeOpacity=".45" />
      <rect x="88" y="112" width="24" height="14" rx="2" />
    </g>
  );
}
function Grinder() {
  return (
    <g {...common}>
      <rect x="74" y="58" width="52" height="84" rx="8" />
      <path d="M74 78 H126 M74 126 H126" strokeOpacity=".55" />
      <path d="M80 86 v32 M88 86 v32 M96 86 v32 M104 86 v32 M112 86 v32 M120 86 v32" strokeOpacity=".35" />
      <path d="M86 58 L90 46 H110 L114 58" />
      <path d="M100 46 V34 H150 V46" />
      <circle cx="150" cy="52" r="7" />
    </g>
  );
}
function Kettle() {
  return (
    <g {...common}>
      <path d="M62 140 L70 70 Q100 58 130 70 L138 140 Z" />
      <path d="M86 64 Q100 50 114 64" />
      <circle cx="100" cy="52" r="4" />
      <path d="M66 96 Q36 92 34 64 Q32 44 18 40" />
      <path d="M134 80 Q160 80 160 104 Q160 126 136 128" />
      <path d="M58 140 H142" />
      <path d="M76 118 Q100 112 124 118" strokeOpacity=".4" />
    </g>
  );
}
function Beans() {
  return (
    <g {...common}>
      <path d="M58 46 L142 46 L150 140 L50 140 Z" />
      <path d="M58 46 L62 30 L138 30 L142 46" />
      <path d="M66 38 H134" strokeOpacity=".5" />
      <ellipse cx="100" cy="94" rx="20" ry="26" transform="rotate(20 100 94)" />
      <path d="M92 72 Q104 94 108 116" />
      <path d="M64 128 H136" strokeOpacity=".4" />
    </g>
  );
}

const ART: Record<string, () => React.JSX.Element> = {
  'np-jacket': Jacket, 'np-boots': Boots, 'np-tent': Tent, 'np-beanie': Beanie,
  'dw-grinder': Grinder, 'dw-kettle': Kettle, 'dw-beans': Beans,
};

export function ProductArt({ productId, className }: { productId: string; className?: string }) {
  const Art = ART[productId] ?? (productId.startsWith('dw') ? Beans : Jacket);
  return (
    <svg className={className} viewBox="0 0 200 160" role="img" aria-hidden="true">
      <Art />
    </svg>
  );
}
