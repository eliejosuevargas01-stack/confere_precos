"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  Clock3,
  Layers3,
  MapPin,
  Minus,
  Package,
  Plus,
  Search,
  ShoppingCart,
  Sparkles,
  Store,
  Tag,
  Trash2,
  TrendingDown,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

const DEFAULT_CITY = "Gaspar";
const CART_STORAGE_KEY = "confere-precos-cart";
const CITY_STORAGE_KEY = "confere-precos-city";

type LocationState = "idle" | "resolving" | "ready" | "saved" | "fallback" | "unsupported";

interface SnapshotResponse {
  snapshot?: StorefrontSnapshot | null;
  status?: StorefrontStatus;
  city?: string;
  error?: string;
}

interface StorefrontStatus {
  refreshing?: boolean;
  startedAt?: string | null;
  completedAt?: string | null;
  hasSnapshot?: boolean;
  city?: string | null;
}

interface StorefrontSnapshot {
  metadata?: SnapshotMetadata;
  siteStatus?: SiteStatusEntry[];
  categories?: SnapshotCategory[];
}

interface SnapshotMetadata {
  generatedAt?: string | null;
  requestedCity?: string | null;
  totalCatalogGroups?: number;
  totalCategories?: number;
  refreshIntervalMinutes?: number;
  nextRefreshAt?: string | null;
}

interface SiteStatusEntry {
  siteDomain?: string | null;
  storeLabel?: string | null;
  effectiveCity?: string | null;
  cityEligible?: boolean;
  searchSupported?: boolean;
}

interface SnapshotCategory {
  id: string;
  label: string;
  productCount?: number;
  comparableCount?: number;
  groups?: SnapshotGroup[];
}

interface SnapshotGroup {
  id?: string;
  categoryId?: string;
  categoryLabel?: string;
  title?: string;
  essentialId?: string;
  essentialLabel?: string;
  packageLabel?: string | null;
  image?: string | null;
  storeCount?: number;
  isComparable?: boolean;
  comparisonMode?: string;
  lowestPriceValue?: number | null;
  highestPriceValue?: number | null;
  priceSpreadValue?: number | null;
  cheapestOffer?: SnapshotOffer | null;
  offers?: SnapshotOffer[];
}

interface SnapshotOffer {
  siteDomain?: string | null;
  storeLabel?: string | null;
  effectiveCity?: string | null;
  sourceUrl?: string | null;
  price?: string | null;
  priceValue?: number | null;
  originalPrice?: string | null;
  originalPriceValue?: number | null;
  isPromotion?: boolean;
  promotionLabel?: string | null;
  discountPercent?: number | null;
  image?: string | null;
  link?: string | null;
  unit?: string | null;
  name?: string | null;
  matchScore?: number | null;
  isCheapest?: boolean;
}

interface ProductGroup extends SnapshotGroup {
  id: string;
  title: string;
  categoryId: string;
  categoryLabel: string;
  essentialId: string;
  essentialLabel: string;
  offers: SnapshotOffer[];
  comparedStores: string[];
  bestDiscountPercent: number;
  highlightText: string;
}

interface ProductFamily {
  id: string;
  categoryId: string;
  categoryLabel: string;
  essentialId: string;
  label: string;
  productCount: number;
  comparableProductCount: number;
  comparedStores: string[];
  bestGroup: ProductGroup;
  bestDiscountPercent: number;
  bestPriceSpreadValue: number;
  groups: ProductGroup[];
}

interface FamilyCategory extends SnapshotCategory {
  groups: SnapshotGroup[];
  familyCount: number;
  comparableFamilyCount: number;
  families: ProductFamily[];
}

interface CartItem {
  group: ProductGroup;
  quantity: number;
}

interface CartStoreGroup {
  total: number;
  items: Array<{ group: ProductGroup; quantity: number; bestOffer: SnapshotOffer | null }>;
}

async function fetcher(url: string): Promise<SnapshotResponse> {
  const response = await fetch(url);
  const payload = (await response.json().catch(() => null)) as SnapshotResponse | null;

  if (!response.ok && response.status !== 202 && response.status !== 503) {
    throw new Error(payload?.error || "Nao foi possivel carregar os dados da vitrine.");
  }

  return payload || {};
}

export default function Storefront() {
  const [city, setCity] = useState(DEFAULT_CITY);
  const [locationState, setLocationState] = useState<LocationState>("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [selectedFamilyId, setSelectedFamilyId] = useState<string | null>(null);
  const [expandedProductId, setExpandedProductId] = useState<string | null>(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [cart, setCart] = useState<Record<string, CartItem>>({});

  const { data, error, isLoading } = useSWR<SnapshotResponse>(
    `/api/storefront?city=${encodeURIComponent(city)}`,
    fetcher,
    {
      refreshInterval: 60_000,
    },
  );

  useEffect(() => {
    const savedCart = window.localStorage.getItem(CART_STORAGE_KEY);
    const savedCity = window.localStorage.getItem(CITY_STORAGE_KEY);

    if (savedCart) {
      try {
        setCart(JSON.parse(savedCart) as Record<string, CartItem>);
      } catch {
        window.localStorage.removeItem(CART_STORAGE_KEY);
      }
    }

    if (savedCity) {
      setCity(savedCity);
      setLocationState("saved");
    }
  }, []);

  useEffect(() => {
    window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  }, [cart]);

  useEffect(() => {
    window.localStorage.setItem(CITY_STORAGE_KEY, city);
  }, [city]);

  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationState((current) => (current === "saved" ? current : "unsupported"));
      return;
    }

    setLocationState((current) => (current === "saved" ? current : "resolving"));

    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const response = await fetch(
            `/api/location/resolve?lat=${position.coords.latitude}&lon=${position.coords.longitude}`,
          );
          const payload = (await response.json()) as { city?: string };

          if (payload.city) {
            setCity(payload.city);
            setLocationState("ready");
            return;
          }
        } catch {
          // fall through to fallback state below
        }

        setLocationState((current) => (current === "saved" ? current : "fallback"));
      },
      () => {
        setLocationState((current) => (current === "saved" ? current : "fallback"));
      },
      {
        enableHighAccuracy: false,
        timeout: 8_000,
        maximumAge: 60 * 60 * 1000,
      },
    );
  }, []);

  const snapshot = data?.snapshot || null;
  const status = data?.status;
  const siteStatus = snapshot?.siteStatus || [];

  const familyCategories = useMemo<FamilyCategory[]>(() => {
    const categories = snapshot?.categories || [];

    return categories
      .map((category) => {
        const familyMap = new Map<string, ProductGroup[]>();

        for (const rawGroup of category.groups || []) {
          const group = normalizeGroup(rawGroup, category);
          const familyKey = `${category.id}:${group.essentialId}`;
          const existingGroups = familyMap.get(familyKey) || [];
          existingGroups.push(group);
          familyMap.set(familyKey, existingGroups);
        }

        const families = Array.from(familyMap.entries())
          .map(([familyKey, groups]) => buildProductFamily(familyKey, category, groups))
          .sort(compareFamilies);

        return {
          ...category,
          groups: category.groups || [],
          familyCount: families.length,
          comparableFamilyCount: families.filter((family) => family.comparableProductCount > 0).length,
          families,
        };
      })
      .filter((category) => category.familyCount > 0);
  }, [snapshot?.categories]);

  const allFamilies = useMemo(
    () => familyCategories.flatMap((category) => category.families),
    [familyCategories],
  );

  const filteredFamilies = useMemo(() => {
    const normalizedQuery = normalizeSearchValue(searchQuery);

    return allFamilies.filter((family) => {
      if (activeCategory && family.categoryId !== activeCategory) {
        return false;
      }

      if (!normalizedQuery) {
        return true;
      }

      return familyMatchesSearch(family, normalizedQuery);
    });
  }, [activeCategory, allFamilies, searchQuery]);

  const featuredFamilies = useMemo(
    () => [...allFamilies].sort(compareFamilies).slice(0, 4),
    [allFamilies],
  );

  const selectedFamily = useMemo(
    () => allFamilies.find((family) => family.id === selectedFamilyId) || null,
    [allFamilies, selectedFamilyId],
  );

  useEffect(() => {
    if (!selectedFamily) {
      return;
    }

    if (selectedFamily.groups.length > 0) {
      setExpandedProductId(selectedFamily.groups[0].id);
    }
  }, [selectedFamily]);

  const cartTotal = useMemo(
    () =>
      Object.values(cart).reduce(
        (sum, item) => sum + (item.group.lowestPriceValue || 0) * item.quantity,
        0,
      ),
    [cart],
  );

  const cartItemCount = useMemo(
    () => Object.values(cart).reduce((sum, item) => sum + item.quantity, 0),
    [cart],
  );

  const cartByStore = useMemo<Record<string, CartStoreGroup>>(() => {
    const stores: Record<string, CartStoreGroup> = {};

    for (const { group, quantity } of Object.values(cart)) {
      const bestOffer = pickBestOffer(group.offers);
      const storeName = bestOffer?.storeLabel || "Loja nao identificada";

      if (!stores[storeName]) {
        stores[storeName] = { total: 0, items: [] };
      }

      stores[storeName].total += (bestOffer?.priceValue || 0) * quantity;
      stores[storeName].items.push({ group, quantity, bestOffer });
    }

    return stores;
  }, [cart]);

  const activeCategoryData =
    familyCategories.find((category) => category.id === activeCategory) || null;

  const addToCart = (group: ProductGroup) => {
    setCart((current) => ({
      ...current,
      [group.id]: {
        group,
        quantity: (current[group.id]?.quantity || 0) + 1,
      },
    }));
  };

  const updateQuantity = (groupId: string, delta: number) => {
    setCart((current) => {
      const item = current[groupId];

      if (!item) {
        return current;
      }

      const nextQuantity = item.quantity + delta;

      if (nextQuantity <= 0) {
        const { [groupId]: _removed, ...rest } = current;
        return rest;
      }

      return {
        ...current,
        [groupId]: {
          ...item,
          quantity: nextQuantity,
        },
      };
    });
  };

  if (error && !snapshot) {
    return (
      <div className="min-h-screen bg-stone-50 flex items-center justify-center px-6">
        <div className="w-full max-w-lg rounded-[2rem] border border-red-100 bg-white p-8 shadow-xl shadow-red-100/50">
          <AlertCircle className="w-12 h-12 text-red-500 mb-4" />
          <h1 className="text-2xl font-black text-stone-900">Erro ao carregar a vitrine</h1>
          <p className="text-stone-500 mt-2">
            {error.message || "Nao foi possivel conectar ao servidor neste momento."}
          </p>
        </div>
      </div>
    );
  }

  const showOverview = !searchQuery && !activeCategory;
  const locationLabel = buildLocationLabel(locationState, city);
  const activeStores = siteStatus.filter((entry) => entry.searchSupported && entry.cityEligible);

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(251,146,60,0.18),_transparent_28%),linear-gradient(180deg,_#fffaf5_0%,_#f7f4ee_100%)]">
      <header className="sticky top-0 z-40 border-b border-stone-200/70 bg-white/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 rounded-2xl bg-orange-500 text-white flex items-center justify-center shadow-lg shadow-orange-500/25">
                <Tag className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-xl sm:text-2xl font-black tracking-tight text-stone-950">
                  Confere<span className="text-orange-500">Precos</span>
                </h1>
                <p className="text-xs sm:text-sm text-stone-500">
                  Compare por familia, abra os produtos e veja as lojas lado a lado.
                </p>
              </div>
            </div>
          </div>

          <div className="hidden md:flex flex-1 justify-center">
            <div className="w-full max-w-2xl relative">
              <Search className="w-4 h-4 text-stone-400 absolute left-4 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="Buscar familias, marcas, lojas ou embalagens"
                className="w-full rounded-2xl border border-stone-200 bg-stone-100/70 py-3 pl-11 pr-4 text-sm text-stone-800 outline-none transition focus:border-orange-300 focus:bg-white focus:ring-4 focus:ring-orange-500/10"
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="hidden lg:flex items-center gap-2 rounded-2xl border border-stone-200 bg-stone-100/70 px-3 py-2">
              <MapPin className="w-4 h-4 text-orange-500" />
              <div className="leading-tight">
                <div className="text-sm font-semibold text-stone-800">{city}</div>
                <div className="text-[11px] text-stone-500">{locationLabel}</div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setIsCartOpen(true)}
              className="relative rounded-2xl border border-stone-200 bg-white px-3 py-2 text-stone-700 shadow-sm transition hover:border-orange-200 hover:text-orange-600"
            >
              <div className="flex items-center gap-2">
                <ShoppingCart className="w-4 h-4" />
                <span className="hidden sm:inline text-sm font-semibold">Lista</span>
              </div>
              {cartItemCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 rounded-full bg-orange-500 px-1.5 text-[10px] font-black text-white flex items-center justify-center border-2 border-white">
                  {cartItemCount}
                </span>
              )}
            </button>
          </div>
        </div>

        <div className="md:hidden max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pb-4">
          <div className="relative">
            <Search className="w-4 h-4 text-stone-400 absolute left-4 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Buscar familias, marcas ou lojas"
              className="w-full rounded-2xl border border-stone-200 bg-stone-100/70 py-3 pl-11 pr-4 text-sm text-stone-800 outline-none transition focus:border-orange-300 focus:bg-white focus:ring-4 focus:ring-orange-500/10"
            />
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8 flex flex-col lg:flex-row gap-8">
        <aside className="w-full lg:w-72 shrink-0">
          <div className="lg:sticky lg:top-24 rounded-[2rem] border border-stone-200/70 bg-white/85 p-5 shadow-lg shadow-stone-200/40">
            <div className="flex items-start justify-between gap-3 mb-5">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.24em] text-stone-400">
                  Navegacao
                </p>
                <h2 className="text-lg font-black text-stone-950 mt-1">Categorias</h2>
              </div>
              <div className="rounded-2xl bg-orange-50 px-2.5 py-1 text-xs font-bold text-orange-700">
                {familyCategories.length}
              </div>
            </div>

            <div className="space-y-2">
              <button
                type="button"
                onClick={() => {
                  setActiveCategory(null);
                  setSearchQuery("");
                }}
                className={`w-full rounded-2xl px-4 py-3 text-left transition ${
                  showOverview
                    ? "bg-orange-500 text-white shadow-lg shadow-orange-500/20"
                    : "bg-stone-100/70 text-stone-700 hover:bg-stone-100"
                }`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <div className="font-semibold">Inicio</div>
                    <div className={`text-xs ${showOverview ? "text-orange-100" : "text-stone-500"}`}>
                      Destaques e categorias principais
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4" />
                </div>
              </button>

              {familyCategories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  onClick={() => setActiveCategory(category.id)}
                  className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                    activeCategory === category.id
                      ? "border-orange-200 bg-orange-50 text-orange-700 shadow-sm"
                      : "border-stone-200 bg-white text-stone-700 hover:border-stone-300 hover:bg-stone-50"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-semibold">{category.label}</div>
                      <div className="text-xs text-stone-500 mt-1">
                        {category.familyCount} familias • {category.productCount || category.groups.length} produtos
                      </div>
                    </div>
                    <div className="rounded-full bg-white/80 px-2 py-1 text-xs font-bold text-stone-600">
                      {category.comparableFamilyCount}
                    </div>
                  </div>
                </button>
              ))}
            </div>

            <div className="mt-6 rounded-2xl bg-stone-950 text-white p-4">
              <div className="flex items-center gap-2 text-stone-300 text-xs uppercase tracking-[0.24em] font-bold">
                <Clock3 className="w-3.5 h-3.5" />
                Atualizacao
              </div>
              <div className="mt-2 text-sm font-semibold">
                {formatTimestamp(snapshot?.metadata?.generatedAt) || "Aguardando primeiro snapshot"}
              </div>
              <div className="mt-2 text-xs text-stone-400 leading-relaxed">
                {snapshot?.metadata?.refreshIntervalMinutes
                  ? `Nova leitura prevista a cada ${snapshot.metadata.refreshIntervalMinutes} minutos.`
                  : "O coletor ainda nao publicou dados nesta cidade."}
              </div>
            </div>
          </div>
        </aside>

        <section className="min-w-0 flex-1 space-y-6">
          {status?.refreshing && (
            <div className="rounded-[2rem] border border-sky-100 bg-sky-50 px-5 py-4 text-sky-700 flex items-center gap-3">
              <div className="w-4 h-4 rounded-full border-2 border-sky-300 border-t-sky-600 animate-spin shrink-0" />
              <div className="text-sm">
                Atualizando os preços em segundo plano para <strong>{city}</strong>.
              </div>
            </div>
          )}

          {!snapshot && (isLoading || status?.refreshing) && (
            <div className="rounded-[2rem] border border-stone-200 bg-white p-10 text-center shadow-lg shadow-stone-200/40">
              <div className="w-10 h-10 rounded-full border-4 border-orange-200 border-t-orange-500 animate-spin mx-auto" />
              <h2 className="text-xl font-black text-stone-950 mt-5">Carregando a vitrine</h2>
              <p className="text-stone-500 mt-2">
                O snapshot ainda esta sendo preparado para a cidade selecionada.
              </p>
            </div>
          )}

          {!snapshot && !isLoading && !status?.refreshing && (
            <div className="rounded-[2rem] border border-amber-200 bg-amber-50 p-8">
              <h2 className="text-2xl font-black text-stone-950">Ainda nao existe snapshot salvo</h2>
              <p className="text-stone-600 mt-2">
                A vitrine desta cidade ainda nao foi gerada. Assim que o scraping concluir, os cards
                aparecerao automaticamente.
              </p>
            </div>
          )}

          {snapshot && (
            <>
              {showOverview ? (
                <>
                  <OverviewHero
                    city={city}
                    familyCount={allFamilies.length}
                    productCount={snapshot.metadata?.totalCatalogGroups || 0}
                    storeCount={activeStores.length}
                    locationLabel={locationLabel}
                  />

                  {featuredFamilies.length > 0 && (
                    <section className="space-y-4">
                      <div className="flex items-center gap-2">
                        <Sparkles className="w-5 h-5 text-orange-500" />
                        <h2 className="text-xl font-black text-stone-950">
                          Familias com maior oportunidade agora
                        </h2>
                      </div>

                      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                        {featuredFamilies.map((family) => (
                          <FamilyCard
                            key={family.id}
                            family={family}
                            onOpen={() => setSelectedFamilyId(family.id)}
                            onAdd={() => addToCart(family.bestGroup)}
                          />
                        ))}
                      </div>
                    </section>
                  )}

                  <section className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Layers3 className="w-5 h-5 text-stone-700" />
                      <h2 className="text-xl font-black text-stone-950">
                        Explore por categoria e subfamilia
                      </h2>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {familyCategories.map((category) => (
                        <CategoryOverviewCard
                          key={category.id}
                          category={category}
                          onSelect={() => setActiveCategory(category.id)}
                        />
                      ))}
                    </div>
                  </section>
                </>
              ) : (
                <section className="space-y-5">
                  <div className="rounded-[2rem] border border-stone-200/70 bg-white p-6 shadow-lg shadow-stone-200/40">
                    <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
                      <div>
                        <div className="text-xs font-bold uppercase tracking-[0.24em] text-stone-400">
                          {searchQuery ? "Busca" : "Categoria"}
                        </div>
                        <h2 className="text-2xl font-black text-stone-950 mt-1">
                          {searchQuery
                            ? `Resultados para "${searchQuery}"`
                            : activeCategoryData?.label || "Familias"}
                        </h2>
                        <p className="text-stone-500 mt-2">
                          Primeiro voce escolhe a familia. Depois abre para ver todos os produtos
                          dessa familia e as lojas comparadas item a item.
                        </p>
                      </div>

                      <div className="flex items-center gap-2">
                        <div className="rounded-2xl bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-700">
                          {filteredFamilies.length} familias
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            setActiveCategory(null);
                            setSearchQuery("");
                          }}
                          className="rounded-2xl border border-stone-200 px-4 py-2 text-sm font-semibold text-stone-700 transition hover:border-orange-200 hover:text-orange-600"
                        >
                          Limpar filtros
                        </button>
                      </div>
                    </div>
                  </div>

                  {filteredFamilies.length === 0 ? (
                    <div className="rounded-[2rem] border border-dashed border-stone-300 bg-white p-10 text-center">
                      <Search className="w-10 h-10 text-stone-300 mx-auto" />
                      <h3 className="text-lg font-black text-stone-950 mt-4">
                        Nenhuma familia encontrada
                      </h3>
                      <p className="text-stone-500 mt-2">
                        Ajuste o termo buscado ou selecione outra categoria.
                      </p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                      {filteredFamilies.map((family) => (
                        <FamilyCard
                          key={family.id}
                          family={family}
                          onOpen={() => setSelectedFamilyId(family.id)}
                          onAdd={() => addToCart(family.bestGroup)}
                        />
                      ))}
                    </div>
                  )}
                </section>
              )}
            </>
          )}
        </section>
      </main>

      <AnimatePresence>
        {selectedFamily && (
          <FamilyDrawer
            family={selectedFamily}
            expandedProductId={expandedProductId}
            onToggleProduct={(productId) =>
              setExpandedProductId((current) => (current === productId ? null : productId))
            }
            onClose={() => setSelectedFamilyId(null)}
            onAdd={addToCart}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isCartOpen && (
          <CartDrawer
            cart={cart}
            cartByStore={cartByStore}
            cartTotal={cartTotal}
            onClose={() => setIsCartOpen(false)}
            onUpdateQuantity={updateQuantity}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function OverviewHero({
  city,
  familyCount,
  productCount,
  storeCount,
  locationLabel,
}: {
  city: string;
  familyCount: number;
  productCount: number;
  storeCount: number;
  locationLabel: string;
}) {
  return (
    <section className="rounded-[2rem] border border-stone-200/70 bg-white px-6 py-7 shadow-lg shadow-stone-200/40 overflow-hidden relative">
      <div className="absolute inset-y-0 right-0 w-1/3 bg-[radial-gradient(circle_at_top,_rgba(251,146,60,0.22),_transparent_60%)] pointer-events-none" />

      <div className="relative flex flex-col xl:flex-row xl:items-end xl:justify-between gap-6">
        <div className="max-w-2xl">
          <div className="inline-flex items-center gap-2 rounded-full bg-orange-50 px-3 py-1 text-xs font-bold uppercase tracking-[0.24em] text-orange-700">
            <TrendingDown className="w-3.5 h-3.5" />
            Vitrine pronta
          </div>

          <h2 className="text-3xl sm:text-4xl font-black tracking-tight text-stone-950 mt-4">
            Compare por familia e abra so o que realmente importa.
          </h2>

          <p className="text-stone-600 mt-3 text-sm sm:text-base leading-relaxed">
            Em vez de despejar dezenas de arrozes, shampoos ou detergentes de uma vez, a home
            organiza a jornada em categorias e familias. Depois, ao abrir a familia, voce ve cada
            produto com suas lojas comparadas.
          </p>

          <div className="mt-5 inline-flex items-center gap-2 rounded-2xl bg-stone-100 px-4 py-2 text-sm font-semibold text-stone-700">
            <MapPin className="w-4 h-4 text-orange-500" />
            {city} • {locationLabel}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 xl:min-w-[440px]">
          <HeroStat label="Familias" value={String(familyCount)} />
          <HeroStat label="Produtos" value={String(productCount)} />
          <HeroStat label="Lojas ativas" value={String(storeCount)} />
        </div>
      </div>
    </section>
  );
}

function HeroStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[1.5rem] border border-stone-200 bg-stone-50 px-4 py-4">
      <div className="text-xs font-bold uppercase tracking-[0.24em] text-stone-400">{label}</div>
      <div className="text-2xl font-black text-stone-950 mt-2">{value}</div>
    </div>
  );
}

function CategoryOverviewCard({
  category,
  onSelect,
}: {
  category: FamilyCategory;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="group rounded-[2rem] border border-stone-200/70 bg-white p-5 text-left shadow-lg shadow-stone-200/30 transition hover:-translate-y-0.5 hover:border-orange-200 hover:shadow-orange-100/50"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-xs font-bold uppercase tracking-[0.24em] text-stone-400">
            Categoria
          </div>
          <h3 className="text-xl font-black text-stone-950 mt-2">{category.label}</h3>
        </div>
        <ChevronRight className="w-5 h-5 text-stone-400 transition group-hover:text-orange-500" />
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3">
        <SmallStat label="Familias" value={String(category.familyCount)} />
        <SmallStat label="Produtos" value={String(category.productCount || category.groups.length)} />
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {category.families.slice(0, 4).map((family) => (
          <span
            key={family.id}
            className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600"
          >
            {family.label}
          </span>
        ))}
      </div>
    </button>
  );
}

function SmallStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl bg-stone-50 px-3 py-3">
      <div className="text-[11px] uppercase tracking-[0.18em] font-bold text-stone-400">{label}</div>
      <div className="text-lg font-black text-stone-950 mt-1">{value}</div>
    </div>
  );
}

function FamilyCard({
  family,
  onOpen,
  onAdd,
}: {
  family: ProductFamily;
  onOpen: () => void;
  onAdd: () => void;
}) {
  const group = family.bestGroup;
  const cheapestOffer = group.cheapestOffer || pickBestOffer(group.offers);

  return (
    <article className="rounded-[2rem] border border-stone-200/70 bg-white p-5 shadow-lg shadow-stone-200/30">
      <div className="flex flex-col sm:flex-row gap-5">
        <button
          type="button"
          onClick={onOpen}
          className="w-full sm:w-[210px] rounded-[1.5rem] border border-stone-200 bg-stone-50 p-4 flex items-center justify-center shrink-0 transition hover:border-orange-200"
        >
          {group.image ? (
            <img
              src={group.image}
              alt={group.title}
              className="w-full max-w-[150px] h-[150px] object-contain mix-blend-multiply"
              loading="lazy"
            />
          ) : (
            <Tag className="w-12 h-12 text-stone-200" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-bold text-orange-700">
              {family.label}
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">
              {family.productCount} produtos
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">
              {family.comparedStores.length} lojas comparadas
            </span>
          </div>

          <h3 className="text-xl font-black text-stone-950 mt-3">{group.title}</h3>
          <p className="text-sm text-stone-500 mt-1">
            Destaque atual da familia em <strong>{family.categoryLabel}</strong>.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            {buildFamilySignals(family).map((signal) => (
              <span
                key={signal}
                className="rounded-full border border-stone-200 px-3 py-1 text-xs font-semibold text-stone-700"
              >
                {signal}
              </span>
            ))}
          </div>

          <div className="mt-5 flex flex-col md:flex-row md:items-end md:justify-between gap-5">
            <div>
              <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-stone-400">
                Melhor preco desta familia
              </div>
              <div className="flex items-baseline gap-2 mt-1">
                <span className="text-3xl font-black text-stone-950">
                  {formatCurrency(group.lowestPriceValue) || "Preco indisponivel"}
                </span>
                {cheapestOffer?.originalPrice && group.lowestPriceValue ? (
                  <span className="text-sm text-stone-400 line-through">
                    {cheapestOffer.originalPrice}
                  </span>
                ) : null}
              </div>
              <div className="text-sm text-stone-500 mt-2">
                {cheapestOffer?.storeLabel || "Loja nao identificada"}
              </div>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onOpen}
                className="rounded-2xl border border-stone-200 px-4 py-3 text-sm font-semibold text-stone-700 transition hover:border-orange-200 hover:text-orange-600"
              >
                Ver todos os {family.label.toLowerCase()}
              </button>
              <button
                type="button"
                onClick={onAdd}
                className="rounded-2xl bg-orange-500 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-orange-500/20 transition hover:bg-orange-600"
              >
                Adicionar destaque
              </button>
            </div>
          </div>

          <div className="mt-5 flex flex-wrap gap-2">
            {family.comparedStores.slice(0, 4).map((store) => (
              <span
                key={store}
                className="rounded-full bg-stone-950 px-3 py-1 text-xs font-semibold text-white"
              >
                {store}
              </span>
            ))}
            {family.comparedStores.length > 4 && (
              <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">
                +{family.comparedStores.length - 4} lojas
              </span>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function FamilyDrawer({
  family,
  expandedProductId,
  onToggleProduct,
  onClose,
  onAdd,
}: {
  family: ProductFamily;
  expandedProductId: string | null;
  onToggleProduct: (productId: string) => void;
  onClose: () => void;
  onAdd: (group: ProductGroup) => void;
}) {
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-50 bg-stone-950/45 backdrop-blur-sm"
      />

      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 220 }}
        className="fixed inset-y-0 right-0 z-50 w-full max-w-4xl bg-[#fffaf4] shadow-2xl border-l border-stone-200 flex flex-col"
      >
        <div className="flex items-center justify-between gap-4 border-b border-stone-200 bg-white/85 px-5 py-4 backdrop-blur-xl">
          <div className="min-w-0">
            <div className="text-xs font-bold uppercase tracking-[0.24em] text-stone-400">
              {family.categoryLabel}
            </div>
            <h2 className="text-2xl font-black text-stone-950 truncate">{family.label}</h2>
            <p className="text-sm text-stone-500 mt-1">
              {family.productCount} produtos • {family.comparedStores.length} lojas comparadas
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-stone-200 bg-white p-2 text-stone-500 transition hover:border-orange-200 hover:text-orange-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          <div className="rounded-[2rem] border border-stone-200 bg-white p-5 shadow-lg shadow-stone-200/30">
            <div className="flex flex-col xl:flex-row gap-5">
              <div className="xl:w-[240px] rounded-[1.5rem] border border-stone-200 bg-stone-50 p-4 flex items-center justify-center">
                {family.bestGroup.image ? (
                  <img
                    src={family.bestGroup.image}
                    alt={family.bestGroup.title}
                    className="w-full max-w-[180px] h-[180px] object-contain mix-blend-multiply"
                    loading="lazy"
                  />
                ) : (
                  <Package className="w-12 h-12 text-stone-200" />
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap gap-2">
                  {buildFamilySignals(family).map((signal) => (
                    <span
                      key={signal}
                      className="rounded-full bg-orange-50 px-3 py-1 text-xs font-bold text-orange-700"
                    >
                      {signal}
                    </span>
                  ))}
                </div>

                <h3 className="text-2xl font-black text-stone-950 mt-4">{family.bestGroup.title}</h3>
                <p className="text-stone-500 mt-2">
                  Produto em maior evidência agora dentro desta familia. Abra qualquer card abaixo
                  para ver as lojas comparadas produto a produto.
                </p>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-5">
                  <SmallStat label="Melhor preco" value={formatCurrency(family.bestGroup.lowestPriceValue) || "N/A"} />
                  <SmallStat label="Produtos" value={String(family.productCount)} />
                  <SmallStat label="Lojas" value={String(family.comparedStores.length)} />
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {family.groups.map((group) => {
              const isExpanded = expandedProductId === group.id;
              const bestOffer = group.cheapestOffer || pickBestOffer(group.offers);

              return (
                <article
                  key={group.id}
                  className="rounded-[2rem] border border-stone-200 bg-white p-5 shadow-lg shadow-stone-200/20"
                >
                  <div className="flex flex-col lg:flex-row gap-4">
                    <div className="w-full lg:w-[120px] rounded-[1.25rem] border border-stone-200 bg-stone-50 p-3 flex items-center justify-center shrink-0">
                      {group.image ? (
                        <img
                          src={group.image}
                          alt={group.title}
                          className="w-full max-w-[88px] h-[88px] object-contain mix-blend-multiply"
                          loading="lazy"
                        />
                      ) : (
                        <Tag className="w-8 h-8 text-stone-200" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap gap-2">
                            {group.bestDiscountPercent > 0 && (
                              <span className="rounded-full bg-red-50 px-3 py-1 text-xs font-bold text-red-600">
                                -{group.bestDiscountPercent}%
                              </span>
                            )}
                            {group.isComparable && (
                              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700">
                                Mesmo produto em varias lojas
                              </span>
                            )}
                          </div>

                          <h3 className="text-xl font-black text-stone-950 mt-3">{group.title}</h3>

                          <div className="mt-2 flex flex-wrap gap-2">
                            {group.packageLabel ? (
                              <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">
                                {group.packageLabel}
                              </span>
                            ) : null}
                            <span className="rounded-full bg-stone-100 px-3 py-1 text-xs font-semibold text-stone-600">
                              {group.comparedStores.length} lojas comparadas
                            </span>
                          </div>

                          <div className="mt-4 flex flex-wrap gap-2">
                            {group.comparedStores.slice(0, 5).map((store) => (
                              <span
                                key={store}
                                className="rounded-full border border-stone-200 px-3 py-1 text-xs font-semibold text-stone-700"
                              >
                                {store}
                              </span>
                            ))}
                          </div>
                        </div>

                        <div className="lg:text-right">
                          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-stone-400">
                            Melhor preco
                          </div>
                          <div className="text-3xl font-black text-stone-950 mt-1">
                            {formatCurrency(group.lowestPriceValue) || "Preco indisponivel"}
                          </div>
                          {bestOffer?.originalPrice && (
                            <div className="text-sm text-stone-400 line-through mt-1">
                              {bestOffer.originalPrice}
                            </div>
                          )}
                          <div className="text-sm text-stone-500 mt-2">
                            {bestOffer?.storeLabel || "Loja nao identificada"}
                          </div>
                        </div>
                      </div>

                      <div className="mt-5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                        <button
                          type="button"
                          onClick={() => onToggleProduct(group.id)}
                          className="inline-flex items-center gap-2 rounded-2xl border border-stone-200 px-4 py-3 text-sm font-semibold text-stone-700 transition hover:border-orange-200 hover:text-orange-600"
                        >
                          {isExpanded ? "Ocultar lojas comparadas" : "Ver lojas comparadas"}
                          <ChevronDown className={`w-4 h-4 transition ${isExpanded ? "rotate-180" : ""}`} />
                        </button>

                        <button
                          type="button"
                          onClick={() => onAdd(group)}
                          className="rounded-2xl bg-orange-500 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-orange-500/20 transition hover:bg-orange-600"
                        >
                          Adicionar a lista
                        </button>
                      </div>

                      <AnimatePresence initial={false}>
                        {isExpanded && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="mt-4 rounded-[1.5rem] border border-stone-200 bg-stone-50 p-4 space-y-3">
                              {group.offers.map((offer) => (
                                <div
                                  key={`${group.id}-${offer.storeLabel}-${offer.link}`}
                                  className={`rounded-[1.25rem] border px-4 py-3 ${
                                    offer.isCheapest
                                      ? "border-emerald-200 bg-emerald-50"
                                      : "border-stone-200 bg-white"
                                  }`}
                                >
                                  <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
                                    <div className="min-w-0">
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span className="font-bold text-stone-900">
                                          {offer.storeLabel || "Loja nao identificada"}
                                        </span>
                                        {offer.effectiveCity && (
                                          <span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-stone-600">
                                            {offer.effectiveCity}
                                          </span>
                                        )}
                                        {offer.isCheapest && (
                                          <span className="rounded-full bg-emerald-600 px-2.5 py-1 text-[11px] font-bold text-white">
                                            Mais barato
                                          </span>
                                        )}
                                      </div>

                                      <div className="text-sm text-stone-500 mt-1">
                                        {offer.name || group.title}
                                      </div>

                                      <div className="flex flex-wrap gap-2 mt-3">
                                        {offer.unit ? (
                                          <span className="rounded-full bg-stone-100 px-2.5 py-1 text-[11px] font-semibold text-stone-600">
                                            {offer.unit}
                                          </span>
                                        ) : null}
                                        {offer.discountPercent ? (
                                          <span className="rounded-full bg-red-50 px-2.5 py-1 text-[11px] font-bold text-red-600">
                                            -{offer.discountPercent}%
                                          </span>
                                        ) : null}
                                        {offer.promotionLabel ? (
                                          <span className="rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-bold text-orange-700">
                                            {offer.promotionLabel}
                                          </span>
                                        ) : null}
                                      </div>
                                    </div>

                                    <div className="md:text-right shrink-0">
                                      <div className="text-2xl font-black text-stone-950">
                                        {formatCurrency(offer.priceValue) || offer.price || "Sem preco"}
                                      </div>
                                      {offer.originalPrice ? (
                                        <div className="text-sm text-stone-400 line-through mt-1">
                                          {offer.originalPrice}
                                        </div>
                                      ) : null}
                                      {offer.link && (
                                        <a
                                          href={offer.link}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="mt-3 inline-flex items-center gap-2 text-sm font-semibold text-orange-600 hover:text-orange-700"
                                        >
                                          Abrir produto
                                          <ArrowRight className="w-4 h-4" />
                                        </a>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      </motion.aside>
    </>
  );
}

function CartDrawer({
  cart,
  cartByStore,
  cartTotal,
  onClose,
  onUpdateQuantity,
}: {
  cart: Record<string, CartItem>;
  cartByStore: Record<string, CartStoreGroup>;
  cartTotal: number;
  onClose: () => void;
  onUpdateQuantity: (groupId: string, delta: number) => void;
}) {
  const orderedStores = Object.entries(cartByStore).sort((left, right) => right[1].total - left[1].total);

  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="fixed inset-0 z-50 bg-stone-950/45 backdrop-blur-sm"
      />

      <motion.aside
        initial={{ x: "100%" }}
        animate={{ x: 0 }}
        exit={{ x: "100%" }}
        transition={{ type: "spring", damping: 28, stiffness: 220 }}
        className="fixed inset-y-0 right-0 z-50 w-full max-w-md bg-white shadow-2xl border-l border-stone-200 flex flex-col"
      >
        <div className="flex items-center justify-between gap-3 border-b border-stone-100 px-5 py-4">
          <div>
            <div className="text-xs font-bold uppercase tracking-[0.24em] text-stone-400">
              Lista inteligente
            </div>
            <h2 className="text-xl font-black text-stone-950">Onde comprar</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-2xl border border-stone-200 bg-white p-2 text-stone-500 transition hover:border-orange-200 hover:text-orange-600"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-5 space-y-5">
          {Object.keys(cart).length === 0 ? (
            <div className="rounded-[2rem] border border-dashed border-stone-300 bg-stone-50 p-8 text-center">
              <ShoppingCart className="w-10 h-10 text-stone-300 mx-auto" />
              <h3 className="text-lg font-black text-stone-950 mt-4">Sua lista esta vazia</h3>
              <p className="text-sm text-stone-500 mt-2">
                Adicione produtos nas familias para montar o roteiro por loja.
              </p>
            </div>
          ) : (
            <>
              <div className="space-y-3">
                {Object.values(cart).map(({ group, quantity }) => (
                  <div
                    key={group.id}
                    className="rounded-[1.5rem] border border-stone-200 bg-stone-50 p-4 flex gap-3"
                  >
                    <div className="w-16 h-16 rounded-2xl border border-stone-200 bg-white p-2 flex items-center justify-center shrink-0">
                      {group.image ? (
                        <img
                          src={group.image}
                          alt={group.title}
                          className="w-full h-full object-contain mix-blend-multiply"
                          loading="lazy"
                        />
                      ) : (
                        <Tag className="w-6 h-6 text-stone-200" />
                      )}
                    </div>

                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-stone-950 text-sm leading-tight">{group.title}</h3>
                      <p className="text-xs text-stone-500 mt-1">
                        {group.packageLabel || "Produto sem embalagem informada"}
                      </p>

                      <div className="mt-3 flex items-center justify-between gap-3">
                        <div className="text-lg font-black text-orange-600">
                          {formatCurrency(group.lowestPriceValue) || "Sem preco"}
                        </div>
                        <div className="flex items-center gap-1 rounded-full border border-stone-200 bg-white p-1">
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(group.id, -1)}
                            className="rounded-full p-1 text-stone-600 transition hover:bg-stone-100"
                          >
                            {quantity === 1 ? (
                              <Trash2 className="w-3.5 h-3.5 text-red-500" />
                            ) : (
                              <Minus className="w-3.5 h-3.5" />
                            )}
                          </button>
                          <span className="min-w-6 text-center text-sm font-bold text-stone-800">
                            {quantity}
                          </span>
                          <button
                            type="button"
                            onClick={() => onUpdateQuantity(group.id, 1)}
                            className="rounded-full p-1 text-stone-600 transition hover:bg-stone-100"
                          >
                            <Plus className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="border-t border-stone-100 pt-4">
                <div className="flex items-center gap-2 mb-3">
                  <Store className="w-4 h-4 text-stone-400" />
                  <h3 className="text-sm font-black text-stone-950">Roteiro por loja</h3>
                </div>

                <div className="space-y-3">
                  {orderedStores.map(([store, data], index) => (
                    <div
                      key={store}
                      className="rounded-[1.5rem] border border-stone-200 bg-white p-4 shadow-sm"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-stone-400">
                            Parada {index + 1}
                          </div>
                          <div className="font-black text-stone-950 mt-1">{store}</div>
                          <div className="text-xs text-stone-500 mt-1">
                            {data.items.length} item(ns) mais baratos nesta loja
                          </div>
                        </div>
                        <div className="text-right">
                          <div className="text-xl font-black text-stone-950">
                            {formatCurrency(data.total) || "N/A"}
                          </div>
                        </div>
                      </div>

                      <div className="mt-4 space-y-2">
                        {data.items.map((item) => (
                          <div
                            key={`${store}-${item.group.id}`}
                            className="rounded-2xl bg-stone-50 px-3 py-2 text-sm text-stone-700"
                          >
                            <div className="font-semibold text-stone-900">
                              {item.quantity}x {item.group.title}
                            </div>
                            <div className="text-xs text-stone-500 mt-1">
                              {formatCurrency(item.bestOffer?.priceValue) || item.bestOffer?.price || "Sem preco"}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {Object.keys(cart).length > 0 && (
          <div className="border-t border-stone-200 bg-stone-50 px-5 py-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs font-bold uppercase tracking-[0.2em] text-stone-400">
                  Total estimado
                </div>
                <div className="text-2xl font-black text-stone-950 mt-1">
                  {formatCurrency(cartTotal) || "N/A"}
                </div>
              </div>

              <div className="rounded-2xl bg-orange-500 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-orange-500/20">
                {Object.keys(cart).length} produto(s)
              </div>
            </div>
          </div>
        )}
      </motion.aside>
    </>
  );
}

function normalizeGroup(group: SnapshotGroup, category: SnapshotCategory): ProductGroup {
  const offers = [...(group.offers || [])]
    .filter((offer) => Number.isFinite(offer.priceValue || null) && (offer.priceValue || 0) > 0)
    .sort(compareOffers);
  const comparedStores = uniqueStrings(offers.map((offer) => offer.storeLabel || null));
  const cheapestOffer = pickBestOffer(offers);
  const bestDiscountPercent = Math.max(0, ...offers.map((offer) => offer.discountPercent || 0));
  const priceSpreadValue =
    Number.isFinite(group.lowestPriceValue) && Number.isFinite(group.highestPriceValue)
      ? (group.highestPriceValue || 0) - (group.lowestPriceValue || 0)
      : 0;

  return {
    ...group,
    id:
      group.id ||
      `${category.id}:${slugifyValue(group.essentialId || group.essentialLabel || group.title || "produto")}`,
    title: group.title || group.essentialLabel || "Produto",
    categoryId: group.categoryId || category.id,
    categoryLabel: group.categoryLabel || category.label,
    essentialId: group.essentialId || slugifyValue(group.essentialLabel || group.title || "familia"),
    essentialLabel: group.essentialLabel || sentenceCase(group.title || "Produto"),
    offers,
    comparedStores,
    cheapestOffer,
    bestDiscountPercent,
    highlightText: buildGroupHighlightText(bestDiscountPercent, priceSpreadValue, group.lowestPriceValue),
  };
}

function buildProductFamily(
  familyKey: string,
  category: SnapshotCategory,
  groups: ProductGroup[],
): ProductFamily {
  const orderedGroups = [...groups].sort(compareGroups);
  const bestGroup = orderedGroups[0];
  const comparedStores = uniqueStrings(
    orderedGroups.flatMap((group) => group.offers.map((offer) => offer.storeLabel || null)),
  );
  const bestDiscountPercent = Math.max(0, ...orderedGroups.map((group) => group.bestDiscountPercent));
  const bestPriceSpreadValue = Math.max(
    0,
    ...orderedGroups.map((group) => group.priceSpreadValue || 0),
  );

  return {
    id: familyKey,
    categoryId: category.id,
    categoryLabel: category.label,
    essentialId: bestGroup.essentialId,
    label: bestGroup.essentialLabel,
    productCount: orderedGroups.length,
    comparableProductCount: orderedGroups.filter((group) => group.isComparable).length,
    comparedStores,
    bestGroup,
    bestDiscountPercent,
    bestPriceSpreadValue,
    groups: orderedGroups,
  };
}

function compareFamilies(left: ProductFamily, right: ProductFamily) {
  const leftScore = scoreFamily(left);
  const rightScore = scoreFamily(right);

  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }

  return left.label.localeCompare(right.label, "pt-BR");
}

function compareGroups(left: ProductGroup, right: ProductGroup) {
  const leftScore = scoreGroup(left);
  const rightScore = scoreGroup(right);

  if (rightScore !== leftScore) {
    return rightScore - leftScore;
  }

  if ((left.lowestPriceValue || Infinity) !== (right.lowestPriceValue || Infinity)) {
    return (left.lowestPriceValue || Infinity) - (right.lowestPriceValue || Infinity);
  }

  return left.title.localeCompare(right.title, "pt-BR");
}

function scoreFamily(family: ProductFamily) {
  return (
    family.comparableProductCount * 300 +
    family.bestDiscountPercent * 18 +
    family.bestPriceSpreadValue * 12 +
    family.comparedStores.length * 10 -
    family.productCount
  );
}

function scoreGroup(group: ProductGroup) {
  return (
    (group.isComparable ? 400 : 0) +
    group.bestDiscountPercent * 20 +
    ((group.priceSpreadValue || 0) * 12) +
    group.comparedStores.length * 10 -
    (group.lowestPriceValue || 0) * 0.01
  );
}

function compareOffers(left: SnapshotOffer, right: SnapshotOffer) {
  const leftPrice = left.priceValue || Infinity;
  const rightPrice = right.priceValue || Infinity;

  if (leftPrice !== rightPrice) {
    return leftPrice - rightPrice;
  }

  return (right.discountPercent || 0) - (left.discountPercent || 0);
}

function pickBestOffer(offers: SnapshotOffer[]) {
  return [...offers].sort(compareOffers)[0] || null;
}

function buildFamilySignals(family: ProductFamily) {
  const signals = [
    family.bestDiscountPercent > 0 ? `Desconto ate ${family.bestDiscountPercent}%` : null,
    family.bestPriceSpreadValue > 0
      ? `Economia de ate ${formatCurrency(family.bestPriceSpreadValue)}`
      : null,
    `${family.productCount} versoes na familia`,
  ];

  return signals.filter(Boolean) as string[];
}

function buildGroupHighlightText(
  discountPercent: number,
  priceSpreadValue: number,
  lowestPriceValue: number | null | undefined,
) {
  if (discountPercent > 0) {
    return `Desconto de ${discountPercent}%`;
  }

  if (priceSpreadValue > 0) {
    return `Economia de ${formatCurrency(priceSpreadValue)}`;
  }

  return lowestPriceValue ? `Melhor preco em ${formatCurrency(lowestPriceValue)}` : "Preco indisponivel";
}

function familyMatchesSearch(family: ProductFamily, normalizedQuery: string) {
  const haystacks = [
    family.label,
    family.categoryLabel,
    ...family.comparedStores,
    ...family.groups.flatMap((group) => [
      group.title,
      group.packageLabel || "",
      ...group.offers.flatMap((offer) => [
        offer.storeLabel || "",
        offer.name || "",
        offer.unit || "",
      ]),
    ]),
  ];

  return haystacks.some((value) => normalizeSearchValue(value).includes(normalizedQuery));
}

function formatCurrency(value: number | null | undefined) {
  return Number.isFinite(value || null)
    ? new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value || 0)
    : null;
}

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(parsed);
}

function buildLocationLabel(state: LocationState, city: string) {
  switch (state) {
    case "ready":
      return `Localizacao automatica ativa em ${city}`;
    case "saved":
      return "Cidade salva anteriormente";
    case "resolving":
      return "Detectando sua cidade";
    case "unsupported":
      return "Geolocalizacao indisponivel";
    case "fallback":
      return `Usando cidade padrao: ${city}`;
    default:
      return `Usando cidade padrao: ${city}`;
  }
}

function normalizeSearchValue(value: string | null | undefined) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function slugifyValue(value: string) {
  return normalizeSearchValue(value).replace(/\s+/g, "-");
}

function sentenceCase(value: string) {
  const trimmed = String(value || "").trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : "";
}

function uniqueStrings(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}
