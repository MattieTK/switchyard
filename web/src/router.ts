import { useEffect, useState } from "react";

export interface Route {
  page: string;
  id?: string;
  query: URLSearchParams;
}

export function parseHash(hash: string): Route {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?");
  const [page, id] = path.split("/");
  return { page: page || "connect", id: id || undefined, query: new URLSearchParams(query) };
}

export function useRoute(): Route {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return parseHash(hash);
}

export function go(hash: string): void {
  location.hash = hash;
}
