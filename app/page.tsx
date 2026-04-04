"use client";

import { useState, useEffect, useMemo } from "react";
import useSWR from "swr";
import { 
  Search, MapPin, ShoppingCart, ChevronRight, 
  Tag, TrendingDown, Store, AlertCircle, Plus, Minus, Trash2, X
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

const fetcher = (url: string) => fetch(url).then((res) => res.json());

export default function Storefront() {
  const [city, setCity] = useState("Gaspar"); // Default city
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [isCartOpen, setIsCartOpen] = useState(false);
  const [cart, setCart] = useState<Record<string, { group: any, quantity: number }>>({});

  const { data, error, isLoading, mutate } = useSWR(`/api/storefront?city=${city}`, fetcher, {
    refreshInterval: 60000, // Refresh every minute
  });

  // Load cart from local storage on mount
  useEffect(() => {
    const saved = localStorage.getItem("confere-precos-cart");
    if (saved) {
      try {
        setCart(JSON.parse(saved));
      } catch (e) {}
    }
  }, []);

  // Save cart to local storage
  useEffect(() => {
    localStorage.setItem("confere-precos-cart", JSON.stringify(cart));
  }, [cart]);

  const snapshot = data?.snapshot;
  const status = data?.status;

  const categories = snapshot?.categories || [];
  const featured = snapshot?.featured || [];

  // Flatten all groups for search
  const allGroups = useMemo(() => {
    const cats = snapshot?.categories || [];
    return cats.flatMap((c: any) => c.groups || []);
  }, [snapshot?.categories]);

  const filteredGroups = useMemo(() => {
    let result = allGroups;
    
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter((g: any) => 
        g.title?.toLowerCase().includes(q) || 
        g.offers?.some((o: any) => o.storeLabel?.toLowerCase().includes(q))
      );
    } else if (activeCategory) {
      result = result.filter((g: any) => g.categoryId === activeCategory);
    }

    return result;
  }, [allGroups, searchQuery, activeCategory]);

  const addToCart = (group: any) => {
    const id = group.id || group.groupId;
    setCart(prev => ({
      ...prev,
      [id]: {
        group,
        quantity: (prev[id]?.quantity || 0) + 1
      }
    }));
  };

  const updateQuantity = (groupId: string, delta: number) => {
    setCart(prev => {
      const item = prev[groupId];
      if (!item) return prev;
      
      const newQuantity = item.quantity + delta;
      if (newQuantity <= 0) {
        const { [groupId]: _, ...rest } = prev;
        return rest;
      }
      
      return {
        ...prev,
        [groupId]: { ...item, quantity: newQuantity }
      };
    });
  };

  const cartTotal = Object.values(cart).reduce((sum, item) => {
    return sum + (item.group.lowestPriceValue || 0) * item.quantity;
  }, 0);

  const cartItemCount = Object.values(cart).reduce((sum, item) => sum + item.quantity, 0);

  // Group cart items by store to show where to buy
  const cartByStore = useMemo(() => {
    const stores: Record<string, { total: number, items: any[] }> = {};
    
    Object.values(cart).forEach(item => {
      // Find the best offer for this item
      const bestOffer = item.group.offers?.reduce((prev: any, curr: any) => {
        const prevPrice = parseFloat(prev.price.replace(/[^\d,]/g, '').replace(',', '.'));
        const currPrice = parseFloat(curr.price.replace(/[^\d,]/g, '').replace(',', '.'));
        return currPrice < prevPrice ? curr : prev;
      }, item.group.offers[0]);

      if (bestOffer) {
        const storeName = bestOffer.storeLabel || "Desconhecido";
        if (!stores[storeName]) stores[storeName] = { total: 0, items: [] };
        
        const price = parseFloat(bestOffer.price.replace(/[^\d,]/g, '').replace(',', '.'));
        stores[storeName].total += price * item.quantity;
        stores[storeName].items.push({ ...item, bestOffer });
      }
    });
    
    return stores;
  }, [cart]);

  if (error && !data) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <div className="text-center max-w-md p-8 bg-white rounded-3xl shadow-xl border border-red-100">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-2xl font-bold text-stone-900 mb-2">Erro ao carregar</h2>
          <p className="text-stone-500">{error.message || "Não foi possível conectar ao servidor."}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex flex-col bg-stone-50/50">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-xl border-b border-stone-200/60">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-orange-500 rounded-xl flex items-center justify-center shadow-sm shadow-orange-500/20">
              <Tag className="w-4 h-4 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight text-stone-900 hidden sm:block">
              Confere<span className="text-orange-500">Preços</span>
            </h1>
          </div>

          <div className="flex-1 max-w-2xl flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
              <input
                type="text"
                placeholder="Buscar produtos, marcas..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-stone-100/50 border border-transparent focus:bg-white focus:border-orange-500/30 focus:ring-4 focus:ring-orange-500/10 rounded-2xl text-sm transition-all outline-none"
              />
            </div>
            <div className="hidden md:flex items-center gap-2 px-3 py-2 bg-stone-100/50 rounded-2xl text-sm font-medium text-stone-600 border border-stone-200/50">
              <MapPin className="w-4 h-4 text-orange-500" />
              {city}
            </div>
          </div>

          <button 
            onClick={() => setIsCartOpen(true)}
            className="relative p-2 text-stone-600 hover:bg-stone-100 rounded-xl transition-colors"
          >
            <ShoppingCart className="w-5 h-5" />
            {cartItemCount > 0 && (
              <span className="absolute top-0 right-0 w-4 h-4 bg-orange-500 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white">
                {cartItemCount}
              </span>
            )}
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-7xl mx-auto w-full px-4 sm:px-6 lg:px-8 py-8 flex flex-col md:flex-row gap-8">
        {/* Sidebar Categories */}
        <aside className="w-full md:w-64 shrink-0">
          <div className="sticky top-24 space-y-1">
            <h3 className="text-xs font-bold uppercase tracking-wider text-stone-400 mb-3 px-3">Categorias</h3>
            <button
              onClick={() => { setActiveCategory(null); setSearchQuery(""); }}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                !activeCategory && !searchQuery
                  ? "bg-orange-500 text-white shadow-md shadow-orange-500/20"
                  : "text-stone-600 hover:bg-stone-100"
              }`}
            >
              <span>Destaques</span>
              {!activeCategory && !searchQuery && <ChevronRight className="w-4 h-4 opacity-70" />}
            </button>
            
            {categories.map((cat: any) => (
              <button
                key={cat.id}
                onClick={() => { setActiveCategory(cat.id); setSearchQuery(""); }}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-sm font-medium transition-all ${
                  activeCategory === cat.id && !searchQuery
                    ? "bg-white text-orange-600 shadow-sm border border-orange-100"
                    : "text-stone-600 hover:bg-stone-100 border border-transparent"
                }`}
              >
                <span className="truncate pr-2">{cat.label}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full ${
                  activeCategory === cat.id && !searchQuery ? "bg-orange-100 text-orange-700" : "bg-stone-100 text-stone-500"
                }`}>
                  {cat.productCount || cat.groups?.length || 0}
                </span>
              </button>
            ))}
          </div>
        </aside>

        {/* Main Content */}
        <div className="flex-1 min-w-0">
          {isLoading && !snapshot ? (
            <div className="flex flex-col items-center justify-center h-64 space-y-4">
              <div className="w-8 h-8 border-4 border-orange-500/30 border-t-orange-500 rounded-full animate-spin" />
              <p className="text-stone-500 font-medium animate-pulse">Buscando melhores preços...</p>
            </div>
          ) : (
            <div className="space-y-8">
              {/* Status Banner */}
              {status?.refreshing && (
                <div className="bg-blue-50 border border-blue-100 text-blue-700 px-4 py-3 rounded-2xl text-sm flex items-center gap-3">
                  <div className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin shrink-0" />
                  Atualizando preços em segundo plano...
                </div>
              )}

              {/* Featured Section (Only show when no category/search is active) */}
              {!activeCategory && !searchQuery && featured.length > 0 && (
                <section>
                  <div className="flex items-center gap-2 mb-4">
                    <TrendingDown className="w-5 h-5 text-orange-500" />
                    <h2 className="text-lg font-bold text-stone-900">Maiores Quedas de Preço</h2>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {featured.slice(0, 4).map((item: any) => (
                      <ProductCard key={item.id || item.groupId} item={item} onAdd={() => addToCart(item)} />
                    ))}
                  </div>
                </section>
              )}

              {/* Product Grid */}
              <section>
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-lg font-bold text-stone-900">
                    {searchQuery ? `Resultados para "${searchQuery}"` : 
                     activeCategory ? categories.find((c:any) => c.id === activeCategory)?.label : 
                     "Todos os Produtos"}
                  </h2>
                  <span className="text-sm font-medium text-stone-500 bg-stone-100 px-3 py-1 rounded-full">
                    {filteredGroups.length} itens
                  </span>
                </div>
                
                {filteredGroups.length === 0 ? (
                  <div className="text-center py-20 bg-white rounded-3xl border border-stone-200 border-dashed">
                    <Search className="w-10 h-10 text-stone-300 mx-auto mb-3" />
                    <h3 className="text-stone-900 font-medium">Nenhum produto encontrado</h3>
                    <p className="text-stone-500 text-sm mt-1">Tente buscar por outro termo ou categoria.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                    {filteredGroups.map((item: any) => (
                      <ProductCard key={item.id || item.groupId} item={item} onAdd={() => addToCart(item)} />
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </main>

      {/* Shopping Cart Drawer */}
      <AnimatePresence>
        {isCartOpen && (
          <>
            <motion.div 
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              onClick={() => setIsCartOpen(false)}
              className="fixed inset-0 bg-stone-900/40 backdrop-blur-sm z-50"
            />
            <motion.div 
              initial={{ x: "100%" }} animate={{ x: 0 }} exit={{ x: "100%" }}
              transition={{ type: "spring", damping: 25, stiffness: 200 }}
              className="fixed inset-y-0 right-0 w-full max-w-md bg-white shadow-2xl z-50 flex flex-col border-l border-stone-200"
            >
              <div className="flex items-center justify-between p-4 border-b border-stone-100">
                <div className="flex items-center gap-2">
                  <ShoppingCart className="w-5 h-5 text-orange-500" />
                  <h2 className="text-lg font-bold text-stone-900">Sua Lista</h2>
                </div>
                <button onClick={() => setIsCartOpen(false)} className="p-2 text-stone-400 hover:bg-stone-100 rounded-full transition-colors">
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-6">
                {Object.keys(cart).length === 0 ? (
                  <div className="text-center py-12">
                    <div className="w-16 h-16 bg-stone-50 rounded-full flex items-center justify-center mx-auto mb-4">
                      <ShoppingCart className="w-8 h-8 text-stone-300" />
                    </div>
                    <p className="text-stone-500 font-medium">Sua lista está vazia</p>
                    <p className="text-sm text-stone-400 mt-1">Adicione produtos para comparar o total.</p>
                  </div>
                ) : (
                  <>
                    {/* Items List */}
                    <div className="space-y-3">
                      {Object.values(cart).map(({ group, quantity }) => (
                        <div key={group.id || group.groupId} className="flex gap-3 p-3 bg-stone-50 rounded-2xl border border-stone-100">
                          <div className="w-16 h-16 bg-white rounded-xl border border-stone-100 p-1 shrink-0 flex items-center justify-center">
                            {group.image ? (
                              <img src={group.image} alt={group.title} className="w-full h-full object-contain mix-blend-multiply" />
                            ) : (
                              <Tag className="w-6 h-6 text-stone-200" />
                            )}
                          </div>
                          <div className="flex-1 min-w-0 flex flex-col justify-between">
                            <div>
                              <h4 className="text-sm font-bold text-stone-900 truncate">{group.title}</h4>
                              <p className="text-xs text-stone-500">{group.packageLabel}</p>
                            </div>
                            <div className="flex items-center justify-between mt-2">
                              <span className="font-bold text-orange-600">
                                {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(group.lowestPriceValue || 0)}
                              </span>
                              <div className="flex items-center gap-1 bg-white border border-stone-200 rounded-lg p-0.5">
                                <button onClick={() => updateQuantity(group.id || group.groupId, -1)} className="p-1 hover:bg-stone-100 rounded-md text-stone-600">
                                  {quantity === 1 ? <Trash2 className="w-3.5 h-3.5 text-red-500" /> : <Minus className="w-3.5 h-3.5" />}
                                </button>
                                <span className="w-6 text-center text-sm font-medium">{quantity}</span>
                                <button onClick={() => updateQuantity(group.id || group.groupId, 1)} className="p-1 hover:bg-stone-100 rounded-md text-stone-600">
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Store Breakdown */}
                    <div className="pt-4 border-t border-stone-100">
                      <h3 className="text-sm font-bold text-stone-900 mb-3 flex items-center gap-2">
                        <Store className="w-4 h-4 text-stone-400" />
                        Onde comprar mais barato
                      </h3>
                      <div className="space-y-2">
                        {Object.entries(cartByStore).sort((a,b) => b[1].total - a[1].total).map(([store, data]) => (
                          <div key={store} className="flex items-center justify-between p-3 bg-white border border-stone-200 rounded-xl">
                            <div className="flex items-center gap-2">
                              <div className="w-2 h-2 rounded-full bg-green-500" />
                              <span className="text-sm font-medium text-stone-700">{store}</span>
                              <span className="text-xs text-stone-400">({data.items.length} itens)</span>
                            </div>
                            <span className="font-bold text-stone-900">
                              {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(data.total)}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </>
                )}
              </div>

              {Object.keys(cart).length > 0 && (
                <div className="p-4 bg-stone-50 border-t border-stone-200">
                  <div className="flex items-center justify-between mb-4">
                    <span className="text-stone-500 font-medium">Total Estimado</span>
                    <span className="text-2xl font-black text-stone-900">
                      {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cartTotal)}
                    </span>
                  </div>
                  <button className="w-full py-3.5 bg-orange-500 hover:bg-orange-600 text-white font-bold rounded-xl shadow-lg shadow-orange-500/20 transition-all active:scale-[0.98]">
                    Finalizar Lista
                  </button>
                </div>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function ProductCard({ item, onAdd }: { item: any, onAdd: () => void }) {
  return (
    <div className="group bg-white rounded-2xl border border-stone-200/60 overflow-hidden hover:shadow-xl hover:shadow-stone-200/50 hover:border-orange-200 transition-all duration-300 flex flex-col h-full">
      <div className="relative aspect-square p-4 bg-stone-50/50 flex items-center justify-center">
        {item.discountPercent > 0 && (
          <div className="absolute top-3 left-3 bg-red-500 text-white text-xs font-bold px-2 py-1 rounded-lg shadow-sm">
            -{item.discountPercent}%
          </div>
        )}
        {item.image ? (
          <img 
            src={item.image} 
            alt={item.title} 
            className="w-full h-full object-contain mix-blend-multiply group-hover:scale-105 transition-transform duration-500"
            loading="lazy"
          />
        ) : (
          <Tag className="w-12 h-12 text-stone-200" />
        )}
      </div>
      
      <div className="p-4 flex flex-col flex-1">
        <div className="flex-1">
          <p className="text-xs font-medium text-stone-400 mb-1">{item.packageLabel || "Unidade"}</p>
          <h3 className="font-bold text-stone-900 text-sm leading-tight line-clamp-2 mb-2 group-hover:text-orange-600 transition-colors">
            {item.title}
          </h3>
        </div>
        
        <div className="mt-auto pt-3 border-t border-stone-100">
          <div className="flex items-end justify-between gap-2 mb-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider font-bold text-stone-400 mb-0.5">Melhor Preço</p>
              <div className="flex items-baseline gap-1.5">
                <span className="text-lg font-black text-stone-900">
                  {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(item.lowestPriceValue || 0)}
                </span>
                {item.originalPrice && (
                  <span className="text-xs text-stone-400 line-through decoration-stone-300">
                    {item.originalPrice}
                  </span>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs font-medium text-stone-500 bg-stone-100 px-2 py-1 rounded-md truncate max-w-[120px]">
              {item.offers?.[0]?.storeLabel || "Loja"}
            </span>
            <button 
              onClick={onAdd}
              className="w-8 h-8 rounded-lg bg-orange-50 text-orange-600 flex items-center justify-center hover:bg-orange-500 hover:text-white transition-colors"
              title="Adicionar à lista"
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
