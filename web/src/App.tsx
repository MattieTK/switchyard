import { Tooltip } from "@base-ui/react/tooltip";
import { Connect } from "./pages/Connect.tsx";
import { JobPage } from "./pages/Job.tsx";
import { PlanReview } from "./pages/PlanReview.tsx";
import { Projects } from "./pages/Projects.tsx";
import { useRoute } from "./router.ts";
import { ArrowIcon, SwitchyardMark } from "./ui/icons.tsx";

export function App() {
  const route = useRoute();
  const next = route.query.get("next")?.split(",").filter(Boolean) ?? [];
  // Plans and jobs are reached from the projects list, so that tab stays current there.
  const section = route.page === "connect" ? "connect" : "projects";
  return (
    <Tooltip.Provider delay={200}>
      <header className="topbar">
        <a className="brand" href="#/connect">
          <span className="brand-mark">
            <SwitchyardMark />
          </span>
          Switchyard
        </a>
        <nav className="nav">
          <a href="#/connect" aria-current={section === "connect" ? "page" : undefined}>
            Connect
          </a>
          <a href="#/projects" aria-current={section === "projects" ? "page" : undefined}>
            Projects
          </a>
        </nav>
        <span className="topbar-route">
          Vercel <ArrowIcon /> Cloudflare
        </span>
      </header>
      {route.page === "projects" ? (
        <Projects />
      ) : route.page === "plan" && route.id ? (
        <PlanReview key={route.id} projectId={route.id} next={next} />
      ) : route.page === "jobs" && route.id ? (
        <JobPage key={route.id} jobId={route.id} />
      ) : (
        <Connect />
      )}
    </Tooltip.Provider>
  );
}
