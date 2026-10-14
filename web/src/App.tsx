import { Connect } from "./pages/Connect.tsx";
import { PlanReview } from "./pages/PlanReview.tsx";
import { Projects } from "./pages/Projects.tsx";
import { useRoute } from "./router.ts";

export function App() {
  const route = useRoute();
  const next = route.query.get("next")?.split(",").filter(Boolean) ?? [];
  return (
    <>
      <header>
        <a className="brand" href="#/connect">
          Switchyard
        </a>
        <nav>
          <a href="#/connect">Connect</a> <a href="#/projects">Projects</a>
        </nav>
      </header>
      {route.page === "projects" ? (
        <Projects />
      ) : route.page === "plan" && route.id ? (
        <PlanReview key={route.id} projectId={route.id} next={next} />
      ) : (
        <Connect />
      )}
    </>
  );
}
