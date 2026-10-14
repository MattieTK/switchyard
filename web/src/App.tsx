import { Connect } from "./pages/Connect.tsx";
import { useRoute } from "./router.ts";

export function App() {
  const route = useRoute();
  return (
    <>
      <header>
        <a className="brand" href="#/connect">
          Switchyard
        </a>
        <nav>
          <a href="#/connect">Connect</a>
        </nav>
      </header>
      <Connect />
    </>
  );
}
