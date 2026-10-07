const { SourceRepository } = require('@proteinjs/reflection');

/**
 * A source-graph registration the way the built dist registers its own (dist/generated/index.js: a
 * node typed `typeQualifiedName` + the link to the object, keyed by the qualified name
 * `<package>/<name>`): routes, startup tasks and the default log writer are found by reflection.
 * Shared by the fixture servers under this directory.
 */
function registerSourceObject(typeQualifiedName, name, object) {
  const slash = typeQualifiedName.lastIndexOf('/');
  const type = {
    packageName: typeQualifiedName.slice(0, slash),
    name: typeQualifiedName.slice(slash + 1),
    filePath: null,
    qualifiedName: typeQualifiedName,
    typeParameters: [],
    directParents: null,
  };
  const qualifiedName = `@proteinjs/server/${name}`;
  SourceRepository.merge(
    JSON.stringify({
      options: { directed: true, multigraph: false, compound: false },
      nodes: [
        {
          v: qualifiedName,
          value: {
            packageName: '@proteinjs/server',
            name,
            filePath: __filename,
            qualifiedName,
            type: { ...type, directParents: [type] },
            isExported: true,
            isConst: true,
            sourceType: 0,
          },
        },
        { v: type.qualifiedName },
      ],
      edges: [{ v: qualifiedName, w: type.qualifiedName, value: 'has type' }],
    }),
    { [qualifiedName]: object }
  );
}

module.exports = { registerSourceObject };
