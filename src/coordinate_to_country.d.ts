// coordinate_to_country ships no types. Declare the one call we use rather
// than pulling in an implicit `any`.
declare module "coordinate_to_country" {
  /**
   * Resolve a position to the ISO 3166-1 codes whose territory or maritime
   * zone contains it. Returns [] for open ocean.
   *
   * @param iso2 true for alpha-2 codes ("FJ"), false/omitted for alpha-3
   *             ("FJI").
   */
  function coordinateToCountry(
    latitude: number,
    longitude: number,
    iso2?: boolean,
  ): string[];
  export = coordinateToCountry;
}
