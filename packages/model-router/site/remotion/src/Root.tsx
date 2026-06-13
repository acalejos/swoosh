import { Composition } from "remotion";
import { Hero, HERO_DURATION } from "./Hero";
import { HeroKinetic, HEROK_DURATION } from "./HeroKinetic";

export const Root: React.FC = () => (
  <>
    <Composition id="hero" component={Hero} durationInFrames={HERO_DURATION} fps={30} width={1200} height={900} />
    <Composition id="hero-kinetic" component={HeroKinetic} durationInFrames={HEROK_DURATION} fps={30} width={1200} height={900} />
  </>
);
